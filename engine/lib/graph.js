"use strict";

// Read models for the canvas.
//
// The Swift side draws; this decides what there is to draw. Three groupings are
// supported — every file, folders two levels deep, or the feature modules the
// mapper agreed on — because a 3,000-file repo is unreadable as files and a
// 30-file repo is pointless as folders.

const { db, json: parseJson } = require("./db");

const LAYER_ORDER = [
  "route", "controller", "middleware", "service", "engine", "model",
  "page", "component", "job", "config", "test", "infra", "other",
];


/**
 * One line per pair, not one per fact.
 *
 * A file can both import another and call a named function on it, which is two
 * edges in the database and deliberately so — the second carries meaning the
 * first does not. On the canvas they would be two identical overlapping lines,
 * so they are merged here: the most specific relationship names the edge, and
 * the rest ride along in `kinds` for the tooltip.
 */
const KIND_SPECIFICITY = [
  "route->controller",
  "uses-middleware",
  "renders",
  "calls",
  "import",
  "related",
];

function mergeParallel(edges) {
  const byPair = new Map();
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, { ...edge, kinds: [edge.kind] });
      continue;
    }
    existing.kinds.push(edge.kind);
    existing.weight = Math.max(existing.weight, edge.weight);
    // A pair proven by a real import is not "inferred", whatever else rides on it.
    existing.inferred = existing.inferred && edge.inferred;
    if (edge.evidence && !existing.evidence) existing.evidence = edge.evidence;
    if (edge.how && !existing.how) existing.how = edge.how;
    const rank = (k) => {
      const i = KIND_SPECIFICITY.indexOf(k);
      return i === -1 ? KIND_SPECIFICITY.length : i;
    };
    if (rank(edge.kind) < rank(existing.kind)) existing.kind = edge.kind;
  }
  return [...byPair.values()];
}

function fileRows(repoId, { hideTests = true, minHeat = 0 } = {}) {
  const rows = db
    .prepare(
      `SELECT id, path, ext, loc, layer, role, summary, module, commit_count, churn, heat,
              community, degree, last_change_at
       FROM files
       WHERE repo_id = ? AND deleted = 0`,
    )
    .all(repoId);

  return rows.filter((r) => {
    if (hideTests && r.layer === "test") return false;
    if (minHeat > 0 && r.heat < minHeat) return false;
    return true;
  });
}

function edgeRows(repoId) {
  return db
    .prepare(`SELECT src_id, dst_id, kind, source, weight, how, evidence FROM edges WHERE repo_id = ?`)
    .all(repoId);
}

/** The default grouping for a repo: folders once a graph of files stops being legible. */
function suggestGrouping(repoId) {
  const n = db
    .prepare(`SELECT COUNT(*) AS n FROM files WHERE repo_id = ? AND deleted = 0`)
    .get(repoId).n;
  if (n > 900) return "feature";
  if (n > 400) return "folder";
  return "file";
}

function folderOf(p) {
  const parts = p.split("/");
  return parts.length <= 1 ? "(root)" : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

/**
 * Collapse files into groups, carrying the numbers up: heat is the max (a group
 * is as hot as its hottest file — averaging hides exactly what you are looking
 * for), churn and merges sum, layer is whichever dominates.
 */
function collapse(files, keyOf, labelOf) {
  const groups = new Map();
  for (const f of files) {
    const key = keyOf(f) || "(none)";
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        label: labelOf ? labelOf(key) : key,
        files: [],
        heat: 0,
        churn: 0,
        merges: 0,
        loc: 0,
        layers: new Map(),
        clusters: new Map(),
        lastChangeAt: null,
      };
      groups.set(key, g);
    }
    g.files.push(f.path);
    g.heat = Math.max(g.heat, f.heat);
    g.churn += f.churn;
    g.merges += f.commit_count;
    g.loc += f.loc;
    g.layers.set(f.layer, (g.layers.get(f.layer) || 0) + 1);
    g.clusters.set(f.community, (g.clusters.get(f.community) || 0) + 1);
    if (f.last_change_at && (!g.lastChangeAt || f.last_change_at > g.lastChangeAt)) {
      g.lastChangeAt = f.last_change_at;
    }
  }

  const dominant = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return [...groups.values()].map((g) => ({
    ...g,
    layer: dominant(g.layers),
    cluster: dominant(g.clusters),
    fileCount: g.files.length,
  }));
}

/**
 * The call graph: one node per function, handler, class or component.
 *
 * This is the view that answers "where does POST /repos actually go?" — the
 * file graph can only say that two files touch. Heat is inherited from the
 * owning file, because churn is measured per file by git.
 */
function symbolGraph(repoId, opts = {}) {
  const hideTests = opts.hideTests !== false;

  const symbols = db
    .prepare(
      `SELECT s.id, s.path, s.name, s.kind, s.line, s.signature, s.params, s.exported,
              s.purpose, s.returns, s.in_degree, s.out_degree,
              f.layer AS layer, f.module AS module, f.heat AS heat, f.churn AS churn,
              f.commit_count AS merges, f.last_change_at AS last_change_at
       FROM symbols s
       JOIN files f ON f.repo_id = s.repo_id AND f.path = s.path
       WHERE s.repo_id = ? AND s.deleted = 0 AND f.deleted = 0`,
    )
    .all(repoId)
    .filter((r) => !(hideTests && r.layer === "test"))
    .filter((r) => !(opts.minHeat > 0 && r.heat < opts.minHeat));

  const visible = new Set(symbols.map((s) => s.id));
  const idOf = new Map(symbols.map((s) => [s.id, `${s.path}::${s.name}`]));

  const edges = db
    .prepare(
      `SELECT src_id, dst_id, kind, line, evidence FROM symbol_edges WHERE repo_id = ?`,
    )
    .all(repoId)
    .filter((e) => visible.has(e.src_id) && visible.has(e.dst_id));

  return {
    grouping: "symbol",
    nodes: symbols.map((s) => ({
      id: `${s.path}::${s.name}`,
      label: s.name,
      path: s.path,
      line: s.line,
      symbolKind: s.kind,
      // Handlers colour as routes so an endpoint reads as an endpoint wherever
      // it appears, whatever layer its file was classified into.
      layer: s.kind === "handler" ? "route" : s.kind === "component" ? "component" : s.layer,
      module: s.module,
      cluster: -1,
      role: s.purpose || s.signature,
      summary: s.params ? `(${s.params})` : null,
      signature: s.signature,
      exported: Boolean(s.exported),
      loc: 0,
      heat: s.heat,
      churn: s.churn,
      merges: s.merges,
      degree: s.in_degree + s.out_degree,
      inDegree: s.in_degree,
      outDegree: s.out_degree,
      lastChangeAt: s.last_change_at,
      folder: folderOf(s.path),
    })),
    edges: mergeParallel(
      edges.map((e) => ({
        from: idOf.get(e.src_id),
        to: idOf.get(e.dst_id),
        kind: e.kind,
        inferred: false, // every one of these came from a line of source
        weight: 1,
        how: "static",
        evidence: e.evidence,
        line: e.line,
      })),
    ),
    meta: { ...meta(repoId, symbols.length), symbolCount: symbols.length },
  };
}

/**
 * The graph, ready to lay out.
 *
 * `nodes` carry everything the canvas colours by: layer (hue), heat
 * (brightness and glow), cluster and module (alternative hues), degree (size).
 */
function getGraph(repoId, opts = {}) {
  const grouping = opts.nodes || suggestGrouping(repoId);
  if (grouping === "symbol") return symbolGraph(repoId, opts);
  const files = fileRows(repoId, opts);
  const edges = edgeRows(repoId);
  const pathById = new Map(files.map((f) => [f.id, f.path]));

  if (grouping === "file") {
    const visible = new Set(files.map((f) => f.id));
    return {
      grouping,
      nodes: files.map((f) => ({
        id: f.path,
        label: f.path.split("/").pop(),
        path: f.path,
        layer: f.layer,
        module: f.module,
        cluster: f.community,
        role: f.role,
        summary: f.summary,
        loc: f.loc,
        heat: f.heat,
        churn: f.churn,
        merges: f.commit_count,
        degree: f.degree,
        lastChangeAt: f.last_change_at,
        folder: folderOf(f.path),
      })),
      edges: mergeParallel(
        edges
          .filter((e) => visible.has(e.src_id) && visible.has(e.dst_id))
          .map((e) => ({
            from: pathById.get(e.src_id),
            to: pathById.get(e.dst_id),
            kind: e.kind,
            inferred: e.source === "llm",
            weight: e.weight,
            how: e.how,
            evidence: e.evidence,
          })),
      ),
      meta: meta(repoId, files.length),
    };
  }

  const keyOf = grouping === "folder" ? (f) => folderOf(f.path) : (f) => f.module || "(unassigned)";
  const groups = collapse(files, keyOf);
  const keyByPath = new Map();
  for (const g of groups) for (const p of g.files) keyByPath.set(p, g.key);
  const keyById = new Map(files.map((f) => [f.id, keyByPath.get(f.path)]));

  const aggregated = new Map();
  for (const e of edges) {
    const a = keyById.get(e.src_id);
    const b = keyById.get(e.dst_id);
    if (!a || !b || a === b) continue;
    const key = `${a} ${b} ${e.kind}`;
    const cur = aggregated.get(key) || { from: a, to: b, kind: e.kind, weight: 0, inferred: true, count: 0 };
    cur.weight += e.weight;
    cur.count += 1;
    if (e.source !== "llm") cur.inferred = false;
    aggregated.set(key, cur);
  }

  return {
    grouping,
    nodes: groups.map((g) => ({
      id: g.key,
      label: g.label,
      path: g.key,
      layer: g.layer,
      module: grouping === "feature" ? g.key : null,
      cluster: g.cluster,
      role: `${g.fileCount} files`,
      summary: null,
      loc: g.loc,
      heat: g.heat,
      churn: g.churn,
      merges: g.merges,
      degree: g.fileCount,
      fileCount: g.fileCount,
      files: g.files.slice(0, 200),
      lastChangeAt: g.lastChangeAt,
    })),
    edges: [...aggregated.values()],
    meta: meta(repoId, files.length),
  };
}

function meta(repoId, visibleFiles) {
  const repo = db
    .prepare(
      `SELECT name, default_branch, last_indexed_at, last_indexed_sha, insight FROM repos WHERE id = ?`,
    )
    .get(repoId);
  const layers = db
    .prepare(`SELECT layer, COUNT(*) AS n FROM files WHERE repo_id = ? AND deleted = 0 GROUP BY layer`)
    .all(repoId);
  const modules = db
    .prepare(
      `SELECT module, COUNT(*) AS n FROM files
       WHERE repo_id = ? AND deleted = 0 AND module IS NOT NULL AND module != ''
       GROUP BY module ORDER BY n DESC`,
    )
    .all(repoId);
  const clusters = db
    .prepare(
      `SELECT community AS cluster, COUNT(*) AS n FROM files
       WHERE repo_id = ? AND deleted = 0 AND community >= 0 GROUP BY community ORDER BY n DESC`,
    )
    .all(repoId);

  return {
    repo: repo || null,
    visibleFiles,
    layers: LAYER_ORDER.map((l) => ({
      layer: l,
      count: (layers.find((x) => x.layer === l) || {}).n || 0,
    })).filter((l) => l.count > 0),
    modules,
    clusters,
    edgeCount: db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE repo_id = ?`).get(repoId).n,
  };
}

/** "Changes the most" — the hot list behind the heatmap. */
function hotspots(repoId, limit = 50) {
  return db
    .prepare(
      `SELECT path, layer, module, role, summary, loc, heat, churn, commit_count AS merges,
              degree, last_change_at
       FROM files WHERE repo_id = ? AND deleted = 0 AND heat > 0
       ORDER BY heat DESC LIMIT ?`,
    )
    .all(repoId, limit);
}

/** Everything known about one file, for the detail panel. */
function fileDetail(repoId, filePath) {
  const file = db.prepare(`SELECT * FROM files WHERE repo_id = ? AND path = ?`).get(repoId, filePath);
  if (!file) throw new Error(`${filePath} is not in the index`);

  const neighbours = (direction) =>
    db
      .prepare(
        direction === "out"
          ? `SELECT f.path, f.layer, f.module, e.kind, e.source, e.evidence
             FROM edges e JOIN files f ON f.id = e.dst_id
             WHERE e.repo_id = ? AND e.src_id = ?`
          : `SELECT f.path, f.layer, f.module, e.kind, e.source, e.evidence
             FROM edges e JOIN files f ON f.id = e.src_id
             WHERE e.repo_id = ? AND e.dst_id = ?`,
      )
      .all(repoId, file.id)
      .map((r) => ({ ...r, inferred: r.source === "llm" }));

  const history = db
    .prepare(
      `SELECT c.short_sha AS sha, c.message, c.author, c.committed_at AS date, c.pr_number,
              fc.additions, fc.deletions
       FROM file_changes fc JOIN commits c ON c.id = fc.commit_id
       WHERE fc.repo_id = ? AND fc.path = ?
       ORDER BY c.committed_at DESC LIMIT 30`,
    )
    .all(repoId, filePath);

  const endpoints = db
    .prepare(`SELECT method, path, summary, auth FROM endpoints WHERE repo_id = ? AND handler_path = ?`)
    .all(repoId, filePath);

  return {
    file: { ...file, exports: parseJson(file.exports, []) },
    dependsOn: neighbours("out"),
    usedBy: neighbours("in"),
    history,
    endpoints,
  };
}

/** Everything known about one function, for the inspector. */
function symbolDetail(repoId, path, name) {
  const symbol = db
    .prepare(`SELECT * FROM symbols WHERE repo_id = ? AND path = ? AND name = ?`)
    .get(repoId, path, name);
  if (!symbol) throw new Error(`${name} in ${path} is not in the index`);

  const neighbours = (direction) =>
    db
      .prepare(
        direction === "out"
          ? `SELECT s.name, s.path, s.kind, s.line, e.kind AS edgeKind, e.line AS callLine, e.evidence
             FROM symbol_edges e JOIN symbols s ON s.id = e.dst_id
             WHERE e.repo_id = ? AND e.src_id = ?`
          : `SELECT s.name, s.path, s.kind, s.line, e.kind AS edgeKind, e.line AS callLine, e.evidence
             FROM symbol_edges e JOIN symbols s ON s.id = e.src_id
             WHERE e.repo_id = ? AND e.dst_id = ?`,
      )
      .all(repoId, symbol.id);

  return {
    symbol: {
      ...symbol,
      exported: Boolean(symbol.exported),
      sideEffects: parseJson(symbol.side_effects, []),
      throws: parseJson(symbol.throws, []),
    },
    calls: neighbours("out"),
    calledBy: neighbours("in"),
  };
}

function commits(repoId, limit = 60) {
  return db
    .prepare(
      `SELECT sha, short_sha, author, message, committed_at, is_merge, pr_number,
              (SELECT COUNT(*) FROM file_changes fc WHERE fc.commit_id = commits.id) AS files,
              (SELECT COALESCE(SUM(additions + deletions), 0) FROM file_changes fc WHERE fc.commit_id = commits.id) AS churn
       FROM commits WHERE repo_id = ? ORDER BY committed_at DESC LIMIT ?`,
    )
    .all(repoId, limit);
}

/** Activity per week, for the sparkline above the graph. */
function activity(repoId, weeks = 26) {
  return db
    .prepare(
      `SELECT strftime('%Y-%W', c.committed_at) AS week,
              COUNT(DISTINCT c.id) AS merges,
              COALESCE(SUM(fc.additions + fc.deletions), 0) AS churn
       FROM commits c LEFT JOIN file_changes fc ON fc.commit_id = c.id
       WHERE c.repo_id = ? AND c.committed_at >= datetime('now', ?)
       GROUP BY week ORDER BY week`,
    )
    .all(repoId, `-${weeks * 7} days`);
}

module.exports = {
  getGraph,
  hotspots,
  fileDetail,
  symbolDetail,
  commits,
  activity,
  suggestGrouping,
};
