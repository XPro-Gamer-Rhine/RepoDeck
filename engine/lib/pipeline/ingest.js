"use strict";

// The indexing pipeline: everything that turns a working tree into a graph.
//
//   fetch → update → scan → static edges → merge history → model mapping →
//   feature consolidation → clustering → heat → insight → knowledge graph
//
// A full run rebuilds the whole map. An incremental run re-maps only the files
// the new merges touched, plus their graph neighbours so edges stay coherent.

const fs = require("node:fs");
const path = require("node:path");
const { db, startJob, finishJob } = require("../db");
const { config } = require("../config");
const { progress, emit } = require("../events");
const git = require("../git");
const providers = require("../providers");
const { scanRepo, readManifests, heuristicLayer } = require("../analysis/scan");
const { buildResolverConfig, resolveSpecifier } = require("../analysis/resolve");
const { enclosingSymbol } = require("../analysis/symbols");
const { mapRepository, assignModules, summarizeActivity } = require("../analysis/map");
const { detectCommunities } = require("../analysis/cluster");
const { recomputeHeat } = require("../analysis/heat");
const { buildKnowledgeGraph } = require("../analysis/knowledge");
const { buildFlows } = require("../analysis/flows");
const { buildErrorCatalogue, buildTestMap } = require("../analysis/failures");
const { summarizeNewMerges } = require("../analysis/prsummary");

const running = new Set();

function isRunning(repoId) {
  return running.has(repoId);
}

function getRepo(repoId) {
  const r = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);
  if (!r) throw new Error(`repo ${repoId} not found`);
  return r;
}

/**
 * Has this repository been removed while we were working?
 *
 * Deleting a repository cascades, so an index still running against it starts
 * writing rows whose parent is gone and fails with a raw "FOREIGN KEY constraint
 * failed" several stages later. Checking at the stage boundaries turns that into
 * a clean stop.
 */
function stillExists(repoId) {
  return Boolean(db.prepare(`SELECT 1 AS ok FROM repos WHERE id = ?`).get(repoId));
}

class RepoRemoved extends Error {
  constructor(repoId) {
    super(`repository ${repoId} was removed while it was being indexed`);
    this.name = "RepoRemoved";
    this.removed = true;
  }
}

function creds(repo) {
  return { url: repo.url, auth_type: repo.auth_type, credential_ref: repo.credential_ref };
}

function setStatus(repoId, status, detail) {
  db.prepare(`UPDATE repos SET status = ?, status_detail = ? WHERE id = ?`).run(status, detail ?? null, repoId);
  emit({ t: "repo_status", repoId, status, detail: detail ?? null });
}

function setProgress(repoId, message) {
  db.prepare(`UPDATE repos SET progress = ? WHERE id = ?`).run(message, repoId);
  progress("index", message, { repoId });
}

// ── writes ───────────────────────────────────────────────────────────────────

/** Marks vanished files deleted rather than dropping their history. */
function upsertFiles(repoId, scanned) {
  const seen = new Set(scanned.map((f) => f.path));
  const insert = db.prepare(
    `INSERT INTO files (repo_id, path, ext, loc, layer, exports, deleted)
     VALUES (@repo_id, @path, @ext, @loc, @layer, @exports, 0)
     ON CONFLICT(repo_id, path) DO UPDATE SET
       ext = excluded.ext, loc = excluded.loc, exports = excluded.exports, deleted = 0`,
  );
  db.transaction(() => {
    for (const f of scanned) {
      insert.run({
        repo_id: repoId,
        path: f.path,
        ext: f.ext,
        loc: f.loc,
        layer: heuristicLayer(f.path, f.hints),
        exports: JSON.stringify(f.exports || []),
      });
    }
    const existing = db.prepare(`SELECT path FROM files WHERE repo_id = ? AND deleted = 0`).all(repoId);
    const del = db.prepare(`UPDATE files SET deleted = 1, heat = 0 WHERE repo_id = ? AND path = ?`);
    for (const e of existing) if (!seen.has(e.path)) del.run(repoId, e.path);
  })();
}

function fileIdMap(repoId) {
  const rows = db.prepare(`SELECT id, path FROM files WHERE repo_id = ?`).all(repoId);
  return new Map(rows.map((r) => [r.path, r.id]));
}

/**
 * Static edges are ground truth: every one is an import the runtime really
 * performs, resolved through the repo's own rules. Anything that does not
 * resolve is dropped, never guessed. Returns the resolved import map so the
 * model can be told what is already known.
 */
function buildStaticEdges(repoId, dir, scanned) {
  const ids = fileIdMap(repoId);
  const known = new Set(scanned.map((f) => f.path));
  const cfg = buildResolverConfig(dir);
  const resolvedByFile = new Map();

  const insert = db.prepare(
    `INSERT INTO edges (repo_id, src_id, dst_id, kind, source, weight, how)
     VALUES (?, ?, ?, 'import', 'static', 1, ?)
     ON CONFLICT(repo_id, src_id, dst_id, kind) DO NOTHING`,
  );

  db.transaction(() => {
    db.prepare(`DELETE FROM edges WHERE repo_id = ? AND source = 'static'`).run(repoId);
    for (const f of scanned) {
      const srcId = ids.get(f.path);
      const targets = [];
      for (const spec of f.imports) {
        const hit = resolveSpecifier(f.path, spec, known, cfg);
        if (!hit || hit.target === f.path) continue;
        targets.push(hit.target);
        const dstId = ids.get(hit.target);
        if (srcId && dstId) insert.run(repoId, srcId, dstId, hit.how);
      }
      resolvedByFile.set(f.path, [...new Set(targets)]);
    }
  })();

  return resolvedByFile;
}

/**
 * The call graph, built statically.
 *
 * Symbols come from the scan; the edges come from matching each call site
 * against the exported symbols of the files that call site's file actually
 * imports. Local declarations win over imported ones, because a name defined in
 * the same file is what a call in that file resolves to.
 *
 * Nothing here is inferred: every edge carries the line and the verbatim text
 * of the call that produced it.
 */
function buildSymbolGraph(repoId, scanned, resolvedImports) {
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (repo_id, path, name, kind, line, signature, params, exported, layer, module, deleted, source_sha)
     VALUES (@repo_id, @path, @name, @kind, @line, @signature, @params, @exported, @layer, @module, 0, @source_sha)
     ON CONFLICT(repo_id, path, name) DO UPDATE SET
       kind = excluded.kind, line = excluded.line, signature = excluded.signature,
       params = excluded.params, exported = excluded.exported, layer = excluded.layer,
       module = excluded.module, deleted = 0, source_sha = excluded.source_sha,
       -- Two ways a stored contract stops being true, and both clear it.
       --
       -- A name that was deleted and has come back is a different function that
       -- happens to share a path and a name. And a file whose contents changed
       -- may have rewritten the body entirely while the signature stayed put —
       -- the contract then describes code that is gone. Either way the symbol
       -- goes back in the enrichment queue rather than asserting stale facts.
       purpose      = CASE WHEN symbols.deleted = 1 OR symbols.source_sha IS NOT excluded.source_sha THEN NULL ELSE symbols.purpose END,
       returns      = CASE WHEN symbols.deleted = 1 OR symbols.source_sha IS NOT excluded.source_sha THEN NULL ELSE symbols.returns END,
       side_effects = CASE WHEN symbols.deleted = 1 OR symbols.source_sha IS NOT excluded.source_sha THEN NULL ELSE symbols.side_effects END,
       throws       = CASE WHEN symbols.deleted = 1 OR symbols.source_sha IS NOT excluded.source_sha THEN NULL ELSE symbols.throws END`,
  );

  const fileMeta = new Map(
    db
      .prepare(`SELECT path, layer, module FROM files WHERE repo_id = ?`)
      .all(repoId)
      .map((r) => [r.path, r]),
  );

  db.transaction(() => {
    db.prepare(`UPDATE symbols SET deleted = 1 WHERE repo_id = ?`).run(repoId);
    for (const file of scanned) {
      const meta = fileMeta.get(file.path) || {};
      for (const symbol of file.symbols) {
        insertSymbol.run({
          repo_id: repoId,
          path: file.path,
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          signature: symbol.signature,
          params: symbol.params,
          exported: symbol.exported ? 1 : 0,
          layer: meta.layer || null,
          module: meta.module || null,
          source_sha: file.sha || null,
        });
      }
    }
  })();

  // Index what exists, so resolution is a lookup rather than a scan per call.
  const rows = db
    .prepare(`SELECT id, path, name, exported FROM symbols WHERE repo_id = ? AND deleted = 0`)
    .all(repoId);
  const byFile = new Map();
  for (const r of rows) {
    if (!byFile.has(r.path)) byFile.set(r.path, new Map());
    byFile.get(r.path).set(r.name, r);
  }

  const insertEdge = db.prepare(
    `INSERT INTO symbol_edges (repo_id, src_id, dst_id, kind, line, evidence)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, src_id, dst_id, kind) DO NOTHING`,
  );

  let edges = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM symbol_edges WHERE repo_id = ?`).run(repoId);

    for (const file of scanned) {
      const own = byFile.get(file.path);
      if (!own) continue;
      // Declaration order comes from the scan, which is the only place that
      // knows line numbers; the database rows are just the ids.
      const declared = [...file.symbols].sort((a, b) => a.line - b.line);
      const imported = resolvedImports.get(file.path) || [];

      const resolve = (name) => {
        const local = own.get(name);
        if (local) return local;
        for (const target of imported) {
          const hit = byFile.get(target) && byFile.get(target).get(name);
          if (hit && hit.exported) return hit;
        }
        return null;
      };

      const link = (site, kind) => {
        const dst = resolve(site.name);
        if (!dst) return;
        const enclosing = enclosingSymbol(declared, site.line);
        const src = enclosing ? own.get(enclosing.name) : null;
        if (!src || src.id === dst.id) return;
        insertEdge.run(repoId, src.id, dst.id, kind, site.line, site.text);
        edges++;
      };

      for (const site of file.callSites) link(site, "calls");
      for (const site of file.renders) link(site, "renders");
    }

    // Degrees, for sizing nodes in the symbol view.
    db.prepare(
      `UPDATE symbols SET
         out_degree = (SELECT COUNT(*) FROM symbol_edges e WHERE e.src_id = symbols.id),
         in_degree  = (SELECT COUNT(*) FROM symbol_edges e WHERE e.dst_id = symbols.id)
       WHERE repo_id = ?`,
    ).run(repoId);

    // Module scope exists so that a top-level call has an owner. Where a file
    // has no top-level calls it owns nothing, and keeping it would add one
    // isolated node per file to the graph — thirty dots that mean nothing, in
    // exchange for the handful that mean something.
    db.prepare(
      `DELETE FROM symbols
       WHERE repo_id = ? AND kind = 'module' AND in_degree = 0 AND out_degree = 0`,
    ).run(repoId);
  })();

  emit({ t: "symbols_built", repoId, symbols: rows.length, edges });
  return { symbols: rows.length, edges };
}

/**
 * Verifies a model-proposed edge before it enters the graph: the model must
 * quote a line from the source file, and we check that line really exists.
 * Anything unquotable is discarded — a wrong edge is worse than a missing one.
 */
function evidenceHolds(repoDir, fromPath, evidence) {
  if (!evidence || evidence.trim().length < 6) return false;
  let src;
  try {
    src = fs.readFileSync(path.join(repoDir, fromPath), "utf8");
  } catch {
    return false;
  }
  const needle = evidence.trim();
  if (src.includes(needle)) return true;
  // Tolerate whitespace reflow only — nothing looser than that.
  const squash = (t) => t.replace(/\s+/g, " ").trim();
  return squash(src).includes(squash(needle));
}

async function applyMapping(cfg, repoId, repoDir, repo, scanned, resolvedImports) {
  const context = `Repository "${repo.name}", branch "${repo.default_branch}", ${scanned.length} source files.
Top-level directories: ${[...new Set(scanned.map((f) => f.path.split("/")[0]))].slice(0, 25).join(", ")}`;

  const result = await mapRepository(cfg, scanned, context, resolvedImports, (done, total) =>
    setProgress(repoId, `Mapping with ${cfg.model}: ${done}/${total} files`),
  );

  const ids = fileIdMap(repoId);
  const updateFile = db.prepare(
    `UPDATE files SET layer = ?, role = ?, module = ?, summary = ? WHERE repo_id = ? AND path = ?`,
  );
  const insertEdge = db.prepare(
    `INSERT INTO edges (repo_id, src_id, dst_id, kind, source, weight, evidence, how)
     VALUES (?, ?, ?, ?, 'llm', 0.6, ?, 'inferred')
     ON CONFLICT(repo_id, src_id, dst_id, kind) DO NOTHING`,
  );

  // Each rejection reason is counted separately. A single "kept 0 of 17" cannot
  // tell you whether the model is hallucinating paths, paraphrasing its evidence,
  // or simply re-reporting imports the static pass already proved — and those
  // call for completely different fixes.
  const outcome = {
    proposed: 0,
    kept: 0,
    unknownPath: 0,
    selfEdge: 0,
    redundant: 0,
    unprovenEvidence: 0,
    enrichedStatic: 0,
  };

  db.transaction(() => {
    for (const f of result.files) {
      if (!ids.has(f.path)) continue; // a path we never indexed — ignore it
      updateFile.run(f.layer, f.role, f.module, f.summary, repoId, f.path);
    }

    // Only clear inferred edges for the files being re-mapped. Deleting them
    // repo-wide on an incremental run and re-inserting only the subset meant the
    // graph shed its inferred edges a little more with every sync.
    const remapped = new Set(scanned.map((f) => f.path));
    const clearFor = db.prepare(
      `DELETE FROM edges WHERE repo_id = ? AND source = 'llm' AND src_id = ?`,
    );
    for (const p of remapped) {
      const fileId = ids.get(p);
      if (fileId) clearFor.run(repoId, fileId);
    }
    const staticPairs = new Set(
      db
        .prepare(`SELECT src_id, dst_id FROM edges WHERE repo_id = ? AND source = 'static'`)
        .all(repoId)
        .map((e) => `${e.src_id}>${e.dst_id}`),
    );

    for (const e of result.edges) {
      outcome.proposed++;
      const src = ids.get(e.from);
      const dst = ids.get(e.to);
      if (!src || !dst) {
        outcome.unknownPath++;
        continue;
      }
      if (src === dst) {
        outcome.selfEdge++;
        continue;
      }
      // A static import edge between the same pair is NOT a reason to throw this
      // one away. "A imports B" and "A calls indexRepo() on B" are different
      // facts, and the second is the one an agent needs. Only a `related` edge —
      // which asserts nothing the import did not already say — is redundant.
      if (staticPairs.has(`${src}>${dst}`) && e.kind === "related") {
        outcome.redundant++;
        continue;
      }
      if (!evidenceHolds(repoDir, e.from, e.evidence)) {
        outcome.unprovenEvidence++;
        continue;
      }
      insertEdge.run(repoId, src, dst, e.kind, String(e.evidence).trim().slice(0, 400));
      outcome.kept++;
      if (staticPairs.has(`${src}>${dst}`)) outcome.enrichedStatic++;
    }
  })();

  emit({ t: "edges_verified", repoId, ...outcome });
  return result;
}

function ingestCommits(repoId, commits) {
  const insertCommit = db.prepare(
    `INSERT INTO commits (repo_id, sha, short_sha, author, email, message, committed_at, is_merge, pr_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, sha) DO NOTHING`,
  );
  const insertChange = db.prepare(
    `INSERT INTO file_changes (repo_id, commit_id, path, additions, deletions)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(commit_id, path) DO NOTHING`,
  );
  const findCommit = db.prepare(`SELECT id FROM commits WHERE repo_id = ? AND sha = ?`);

  db.transaction(() => {
    for (const c of commits) {
      insertCommit.run(
        repoId, c.sha, c.shortSha, c.author, c.email, c.subject, c.date, c.isMerge ? 1 : 0, c.prNumber,
      );
      const row = findCommit.get(repoId, c.sha);
      if (!row) continue;
      for (const f of c.files) insertChange.run(repoId, row.id, f.path, f.additions, f.deletions);
    }
  })();
}

/** Re-derive the feature taxonomy and re-assign every file to it. */
async function consolidateModules(cfg, repoId) {
  const all = db
    .prepare(`SELECT path, layer, role FROM files WHERE repo_id = ? AND deleted = 0`)
    .all(repoId);
  const { assignments, taxonomy } = await assignModules(cfg, all).catch(() => ({
    assignments: new Map(),
    taxonomy: [],
  }));
  const setModule = db.prepare(`UPDATE files SET module = ? WHERE repo_id = ? AND path = ?`);
  db.transaction(() => {
    for (const [p, mod] of assignments) setModule.run(mod, repoId, p);
  })();
  return taxonomy;
}

// ── the pipeline ─────────────────────────────────────────────────────────────

/**
 * Index a repository.
 *
 * `full`      rebuild everything (default on the first run)
 * `skipPull`  the caller already brought the tree up to date
 * `knowledge` also rebuild the knowledge graph (default true)
 */
async function indexRepo(repoId, opts = {}) {
  if (running.has(repoId)) throw new Error("An index is already running for this repository.");
  running.add(repoId);

  const started = Date.now();
  const jobId = startJob(repoId, opts.full ? "index" : "sync");
  providers.resetUsage();

  try {
    const repo = getRepo(repoId);
    const branch = repo.default_branch;
    const c = creds(repo);

    // No provider configured is not a hard failure: the static half of the graph
    // (files, real import edges, churn, heat, clusters) is worth having on its
    // own, and the run says plainly which half is missing.
    let cfg = null;
    let providerError = null;
    try {
      cfg = providers.resolveProvider(repo.provider_id);
    } catch (err) {
      providerError = err.message;
      emit({ t: "provider_missing", repoId, message: err.message });
    }

    // ── bring the tree up to date ────────────────────────────────────────────
    let dir = git.workdirFor(repoId, repo.url);
    if (!git.isCloned(dir)) {
      setStatus(repoId, "cloning", `Cloning ${branch}`);
      setProgress(repoId, "Cloning repository");
      dir = await git.cloneRepo(repoId, c, branch, (line) => emit({ t: "log", stream: "git", text: line }));
    }

    if (!opts.skipPull) {
      setProgress(repoId, "Fetching origin");
      await git.fetchBranch(dir, c, branch); // always fetch before we read the remote
      const state = await git.worktreeState(dir, c, branch);
      if (state.behind > 0 || state.branch !== branch) {
        const result = await applyUpdateOrStop(repoId, dir, c, branch, repo.pull_strategy);
        // Belt and braces: never index — or redeploy — a tree that still has an
        // unresolved merge in it.
        const stillConflicted = await git.conflictedPaths(dir, c);
        if (!result.ok || stillConflicted.length > 0) {
          result.ok = false;
          result.conflicts = result.conflicts.length ? result.conflicts : stillConflicted;
        }
        if (!result.ok) {
          // Conflicts stop the pipeline. The caller decides how to resolve them.
          finishJob(jobId, "blocked", `merge conflict in ${result.conflicts.length} file(s)`);
          setStatus(repoId, "error", `Merge conflict in ${result.conflicts.length} file(s)`);
          return { blocked: true, conflicts: result.conflicts };
        }
      }
    }

    const sha = await git.remoteHead(dir, c, branch);
    const previousSha = repo.last_indexed_sha;
    const isFirstRun = !previousSha;
    const full = opts.full ?? isFirstRun;

    if (!full && sha === previousSha && !opts.force) {
      setStatus(repoId, "ready", "Already up to date");
      setProgress(repoId, "");
      finishJob(jobId, "skipped", `no new commits on ${branch}`);
      return { upToDate: true, sha };
    }

    // ── static analysis ──────────────────────────────────────────────────────
    setStatus(repoId, "indexing", "Scanning source tree");
    if (!stillExists(repoId)) throw new RepoRemoved(repoId);
    setProgress(repoId, "Scanning source tree");
    const scanned = scanRepo(dir);
    const manifests = readManifests(dir);
    upsertFiles(repoId, scanned);
    const resolvedImports = buildStaticEdges(repoId, dir, scanned);

    if (!stillExists(repoId)) throw new RepoRemoved(repoId);
    setProgress(repoId, "Building the call graph");
    buildSymbolGraph(repoId, scanned, resolvedImports);

    // Derived, not asked: request paths, the errors this code can raise, and
    // which tests cover what. All three are things an agent needs and none of
    // them should be a model's opinion.
    setProgress(repoId, "Tracing request flows");
    buildFlows(repoId);
    buildErrorCatalogue(repoId, dir, scanned);
    buildTestMap(repoId, dir, scanned, resolvedImports);

    if (!stillExists(repoId)) throw new RepoRemoved(repoId);
    setProgress(repoId, "Reading merge history");
    const commits = await git.listMergeCommits(dir, c, branch, {
      sinceSha: full ? null : previousSha,
      limit: config.limits.historyMaxMerges,
    });
    ingestCommits(repoId, commits);

    // ── model passes ─────────────────────────────────────────────────────────
    let toMap = scanned;
    // What this sync actually touched, so the knowledge-graph passes can be
    // scoped to it instead of re-deriving the whole repository every hour.
    let changedPaths = null;
    if (!full) {
      const touched = new Set(commits.flatMap((x) => x.files.map((f) => f.path)));
      // Neighbours of touched files get re-mapped too, so edges stay coherent.
      // Both directions. Following outgoing edges only re-mapped what a changed
      // file imports and missed everything that imports IT — which is the side
      // that actually breaks when an export is renamed or removed.
      const placeholders = [...touched].map(() => "?").join(",") || "''";
      const neighbours = new Set(
        db
          .prepare(
            `SELECT DISTINCT f2.path AS path
               FROM edges e
               JOIN files f1 ON f1.id = e.src_id
               JOIN files f2 ON f2.id = e.dst_id
              WHERE e.repo_id = ? AND f1.path IN (${placeholders})
             UNION
             SELECT DISTINCT f1.path AS path
               FROM edges e
               JOIN files f1 ON f1.id = e.src_id
               JOIN files f2 ON f2.id = e.dst_id
              WHERE e.repo_id = ? AND f2.path IN (${placeholders})`,
          )
          .all(repoId, ...touched, repoId, ...touched)
          .map((r) => r.path),
      );
      toMap = scanned.filter((f) => touched.has(f.path) || neighbours.has(f.path));

      // Now that dependents count too, touching one widely-imported file pulls
      // in most of the repository — which is the whole cost the incremental path
      // exists to avoid. Keep the touched files and as many neighbours as the
      // budget allows, most-connected first.
      const cap = Math.max(touched.size, config.limits.remapMaxFiles);
      if (toMap.length > cap) {
        const degree = new Map(
          db
            .prepare(`SELECT path, degree FROM files WHERE repo_id = ?`)
            .all(repoId)
            .map((r) => [r.path, r.degree]),
        );
        const ranked = toMap
          .filter((f) => !touched.has(f.path))
          .sort((a, b) => (degree.get(b.path) || 0) - (degree.get(a.path) || 0));
        toMap = [
          ...toMap.filter((f) => touched.has(f.path)),
          ...ranked.slice(0, Math.max(0, cap - touched.size)),
        ];
        emit({ t: "remap_capped", repoId, cap, touched: touched.size });
      }

      changedPaths = new Set(toMap.map((f) => f.path));
    }

    // Tests inflate the bill without describing the architecture; they still
    // appear in the graph with their heuristic layer and their real import edges.
    if (config.limits.skipTests) {
      toMap = toMap.filter((f) => heuristicLayer(f.path, f.hints) !== "test");
    }

    if (cfg && toMap.length > 0) {
      setStatus(repoId, "indexing", `Mapping ${toMap.length} files with ${cfg.model}`);
      await applyMapping(cfg, repoId, dir, repo, toMap, resolvedImports);
    }

    let taxonomy = [];
    if (cfg) {
      setProgress(repoId, "Consolidating feature modules");
      taxonomy = await consolidateModules(cfg, repoId);
    }

    // Symbols carry a copy of their file's layer and module so the call graph can
    // be grouped without a join. That copy is stamped on during symbol
    // extraction, which runs BEFORE the model classifies the files — so on a
    // first index every symbol was written with the heuristic layer and a null
    // module, and the exported call graph said `"module": null` for everything.
    // Re-sync once the real classification exists.
    db.prepare(
      `UPDATE symbols
          SET layer  = (SELECT f.layer  FROM files f WHERE f.repo_id = symbols.repo_id AND f.path = symbols.path),
              module = (SELECT f.module FROM files f WHERE f.repo_id = symbols.repo_id AND f.path = symbols.path)
        WHERE repo_id = ? AND deleted = 0`,
    ).run(repoId);

    if (!stillExists(repoId)) throw new RepoRemoved(repoId);
    setProgress(repoId, "Clustering and computing the heatmap");
    detectCommunities(repoId);
    recomputeHeat(repoId);

    const hot = db
      .prepare(`SELECT path, role, churn FROM files WHERE repo_id = ? AND deleted = 0 ORDER BY heat DESC LIMIT 12`)
      .all(repoId);
    const recent = db
      .prepare(
        `SELECT message AS subject, committed_at AS date FROM commits WHERE repo_id = ? ORDER BY committed_at DESC LIMIT 15`,
      )
      .all(repoId);
    if (cfg) {
      const insight = await summarizeActivity(cfg, repo.name, hot, recent);
      if (insight) db.prepare(`UPDATE repos SET insight = ? WHERE id = ?`).run(insight, repoId);
    }

    // ── what landed ──────────────────────────────────────────────────────────
    // Written before the knowledge graph, because it is the part a person reads
    // and the part that should survive a knowledge-graph failure.
    if (cfg && commits.length > 0 && opts.summaries !== false) {
      setProgress(repoId, `Summarising ${Math.min(commits.length, 10)} merge(s)`);
      await summarizeNewMerges(repoId, commits, {
        // A first index of a long-lived repository would otherwise try to
        // describe every merge in its history.
        limit: isFirstRun ? 3 : 10,
      }).catch((err) => emit({ t: "pr_summary_error", repoId, message: err.message }));
    }

    // ── knowledge graph ──────────────────────────────────────────────────────
    if (cfg && opts.knowledge !== false) {
      setProgress(repoId, "Building the knowledge graph");
      const diffstat = previousSha ? await git.diffStat(dir, c, previousSha, sha) : "";
      await buildKnowledgeGraph(repoId, {
        provider: cfg,
        scanned,
        manifests,
        resolvedImports,
        taxonomy,
        full,
        changedPaths,
      }, {
        commits: full ? commits.slice(0, 25) : commits,
        diffstat,
        sinceSha: previousSha,
        toSha: sha,
      });
    }

    db.prepare(
      `UPDATE repos
       SET last_indexed_sha = ?, last_indexed_at = datetime('now'), last_pulled_at = datetime('now'),
           status = 'ready', status_detail = NULL, progress = ''
       WHERE id = ?`,
    ).run(sha, repoId);

    const u = providers.snapshotUsage();
    const cost = `${u.calls} model calls, ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out`;
    const summary = `${scanned.length} files, ${commits.length} new merges, ${Math.round(
      (Date.now() - started) / 1000,
    )}s · ${cfg ? cost : "static analysis only — no AI provider configured"}`;
    finishJob(jobId, providerError ? "partial" : "ok", summary);
    emit({ t: "index_done", repoId, sha, commits: commits.length, usage: u });

    return {
      sha,
      files: scanned.length,
      commits: commits.length,
      usage: u,
      previousSha,
      providerError,
    };
  } catch (err) {
    if (err && err.removed) {
      // The row is already gone; writing status to it would do nothing, and this
      // is not a failure the user needs to see.
      finishJob(jobId, "cancelled", err.message);
      emit({ t: "index_cancelled", repoId, reason: "repository removed" });
      return { cancelled: true };
    }
    setStatus(repoId, "error", err.message);
    setProgress(repoId, "");
    finishJob(jobId, "error", err.message);
    throw err;
  } finally {
    running.delete(repoId);
  }
}

/**
 * Update the working tree, refusing to destroy work that is not ours.
 *
 * A deploy mirror holds nothing of the user's, so `reset` is silent and safe.
 * The moment the tree has local commits or edits, `reset` would throw them away
 * — so it is upgraded to a real merge, and a conflict there stops the pipeline
 * for an explicit decision instead of being papered over.
 */
async function applyUpdateOrStop(repoId, dir, c, branch, strategy) {
  const state = await git.worktreeState(dir, c, branch);

  const mergeInstead = async (reason) => {
    emit({ t: "pull_guard", repoId, reason, dirty: state.dirtyFiles.length, ahead: state.ahead });
    const merged = await git.applyUpdate(dir, c, branch, "merge");
    if (!merged.ok) {
      db.prepare(`UPDATE repos SET status_detail = ? WHERE id = ?`).run(
        merged.conflicts.length
          ? `Merge conflict in ${merged.conflicts.join(", ")}`
          : merged.refused || "the update could not be applied",
        repoId,
      );
    }
    return merged;
  };

  if (strategy === "reset" && !state.clean) return mergeInstead("local-work");

  const result = await git.applyUpdate(dir, c, branch, strategy);
  // The reset path refuses when the branch it would force-move has commits
  // origin does not — which the current-branch check cannot see. Merging keeps
  // them, which is the whole point of refusing.
  if (result.refused) return mergeInstead("unpushed-commits");
  return result;
}

module.exports = {
  indexRepo,
  isRunning,
  applyUpdateOrStop,
  consolidateModules,
  buildSymbolGraph,
  getRepo,
  creds,
};
