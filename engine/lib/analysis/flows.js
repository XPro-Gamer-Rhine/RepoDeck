"use strict";

// Traced request paths, derived — not guessed.
//
// An agent told "POST /repos eventually writes to the database" cannot act on
// it. An agent told "POST /repos (routes/repos.ts:59) → indexRepo
// (services/ingest.ts:247) → ensureRepo (services/git.ts:88) → db.prepare" can
// open the third file and start reading.
//
// Every step here comes out of the static call graph, so every hop is a real
// call on a real line. Nothing in this file asks a model anything.

const { db, json: parseJson } = require("../db");
const { emit } = require("../events");

const MAX_DEPTH = 8;
const MAX_BRANCHES = 6;

/**
 * Walk outward from one entry symbol, keeping the most informative path through
 * each branch rather than every path — a complete traversal of a real codebase
 * produces thousands of chains and communicates nothing.
 *
 * "Most informative" means: prefer the branch that reaches the deepest
 * architectural layer, because a chain that ends at the database tells you more
 * than one that ends at a logger.
 */
const LAYER_DEPTH = {
  route: 1,
  middleware: 2,
  controller: 3,
  service: 4,
  engine: 5,
  model: 6,
};

function traceFrom(entry, edgesBySrc, symbolsById) {
  const steps = [];
  const seen = new Set([entry.id]);
  const touched = new Set([entry.layer].filter(Boolean));

  let current = entry;
  let depth = 0;

  while (depth < MAX_DEPTH) {
    const outgoing = (edgesBySrc.get(current.id) || [])
      .map((e) => ({ edge: e, node: symbolsById.get(e.dst_id) }))
      .filter((x) => x.node && !seen.has(x.node.id));

    if (outgoing.length === 0) break;

    // Deepest architectural layer first; then the busiest callee, which is
    // usually the one doing the real work rather than a formatting helper.
    outgoing.sort((a, b) => {
      const la = LAYER_DEPTH[a.node.layer] || 0;
      const lb = LAYER_DEPTH[b.node.layer] || 0;
      if (la !== lb) return lb - la;
      return (b.node.in_degree || 0) - (a.node.in_degree || 0);
    });

    const next = outgoing[0];
    seen.add(next.node.id);
    if (next.node.layer) touched.add(next.node.layer);
    depth++;

    steps.push({
      depth,
      name: next.node.name,
      kind: next.node.kind,
      path: next.node.path,
      line: next.node.line,
      callLine: next.edge.line,
      layer: next.node.layer,
      module: next.node.module,
      evidence: next.edge.evidence,
      // The other branches, named but not followed, so a reader knows the path
      // shown is one of several rather than the only one.
      alsoCalls: outgoing.slice(1, MAX_BRANCHES).map((o) => `${o.node.name} (${o.node.path}:${o.node.line})`),
    });

    current = next.node;
  }

  return { steps, touches: [...touched] };
}

/**
 * Build one flow per entry point.
 *
 * Entry points are route handlers first — they are what a request arrives at —
 * then jobs and exported components, which are the other two ways execution
 * starts in most applications.
 */
function buildFlows(repoId) {
  const symbols = db
    .prepare(
      `SELECT s.id, s.path, s.name, s.kind, s.line, s.in_degree, s.out_degree, f.layer, f.module
       FROM symbols s
       JOIN files f ON f.repo_id = s.repo_id AND f.path = s.path
       WHERE s.repo_id = ? AND s.deleted = 0 AND f.deleted = 0`,
    )
    .all(repoId);

  const symbolsById = new Map(symbols.map((s) => [s.id, s]));
  const edgesBySrc = new Map();
  for (const e of db
    .prepare(`SELECT src_id, dst_id, kind, line, evidence FROM symbol_edges WHERE repo_id = ?`)
    .all(repoId)) {
    if (!edgesBySrc.has(e.src_id)) edgesBySrc.set(e.src_id, []);
    edgesBySrc.get(e.src_id).push(e);
  }

  // An entry point is something nothing else in the repository calls. Route
  // handlers always qualify — a request arrives at them from outside — and so do
  // scheduled jobs and top-level screens. Without the in-degree test, every
  // helper in a file that happened to be classified as a job became an "entry",
  // and the flow list filled up with fragments of other people's chains.
  const entries = symbols.filter((s) => {
    if (s.kind === "handler") return true;
    if ((s.in_degree || 0) > 0) return false;
    // Module scope is an entry point when it is where execution begins.
    if (s.kind === "module") return (s.out_degree || 0) > 0;
    if (s.kind === "component" || s.kind === "hook") return true;
    return s.layer === "job" || s.layer === "route";
  });

  const insert = db.prepare(
    `INSERT INTO flows (repo_id, key, entry_path, entry_line, module, steps, depth, touches)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, key, entry_path) DO UPDATE SET
       entry_line = excluded.entry_line, module = excluded.module, steps = excluded.steps,
       depth = excluded.depth, touches = excluded.touches`,
  );

  let written = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM flows WHERE repo_id = ?`).run(repoId);
    // Deepest chains first, so a cap keeps the informative ones.
    const ranked = entries
      .map((entry) => ({ entry, traced: traceFrom(entry, edgesBySrc, symbolsById) }))
      .sort((a, b) => b.traced.steps.length - a.traced.steps.length)
      .slice(0, 400);

    for (const { entry, traced } of ranked) {
      const { steps, touches } = traced;
      // A handler that calls nothing is still worth recording — "this endpoint
      // does its work inline" is a fact an agent needs.
      insert.run(
        repoId,
        entry.name,
        entry.path,
        entry.line,
        entry.module || null,
        JSON.stringify(steps),
        steps.length,
        JSON.stringify(touches),
      );
      written++;
    }
  })();

  emit({ t: "flows_built", repoId, flows: written });
  return { flows: written };
}

function listFlows(repoId) {
  return db
    .prepare(`SELECT * FROM flows WHERE repo_id = ? ORDER BY depth DESC, key`)
    .all(repoId)
    .map((f) => ({
      key: f.key,
      entryPath: f.entry_path,
      entryLine: f.entry_line,
      module: f.module,
      depth: f.depth,
      touches: parseJson(f.touches, []),
      steps: parseJson(f.steps, []),
      summary: f.summary,
    }));
}

module.exports = { buildFlows, listFlows };
