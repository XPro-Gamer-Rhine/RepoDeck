"use strict";

// Louvain community detection over the repo's dependency graph: densely
// interconnected files end up in one community and get one colour on the canvas.

const { db } = require("../db");

function buildGraph(edges, nodes) {
  const adj = new Map();
  const selfLoops = new Map();
  for (const n of nodes) adj.set(n, new Map());
  let total = 0;
  for (const { a, b, w } of edges) {
    if (!adj.has(a) || !adj.has(b)) continue;
    if (a === b) {
      selfLoops.set(a, (selfLoops.get(a) || 0) + w);
      total += w;
      continue;
    }
    adj.get(a).set(b, (adj.get(a).get(b) || 0) + w);
    adj.get(b).set(a, (adj.get(b).get(a) || 0) + w);
    total += w;
  }
  return { nodes, adj, selfLoops, totalWeight: total };
}

function degreeOf(g, n) {
  let d = 2 * (g.selfLoops.get(n) || 0);
  for (const w of g.adj.get(n).values()) d += w;
  return d;
}

/** One Louvain level: greedy local moving until modularity stops improving. */
function localMoving(g) {
  const community = new Map();
  const degree = new Map();
  const commTotal = new Map();

  for (const n of g.nodes) {
    community.set(n, n);
    const d = degreeOf(g, n);
    degree.set(n, d);
    commTotal.set(n, d);
  }

  const m2 = g.totalWeight * 2 || 1;
  let improved = true;
  let rounds = 0;

  while (improved && rounds < 20) {
    improved = false;
    rounds++;
    for (const n of g.nodes) {
      const own = community.get(n);
      const k = degree.get(n);

      const links = new Map();
      for (const [nb, w] of g.adj.get(n)) {
        const c = community.get(nb);
        links.set(c, (links.get(c) || 0) + w);
      }

      commTotal.set(own, commTotal.get(own) - k);

      let bestComm = own;
      let bestGain = (links.get(own) || 0) - (commTotal.get(own) * k) / m2;
      for (const [c, wIn] of links) {
        if (c === own) continue;
        const gain = wIn - ((commTotal.get(c) || 0) * k) / m2;
        if (gain > bestGain + 1e-9) {
          bestGain = gain;
          bestComm = c;
        }
      }

      commTotal.set(bestComm, (commTotal.get(bestComm) || 0) + k);
      community.set(n, bestComm);
      if (bestComm !== own) improved = true;
    }
  }

  return community;
}

function rawEdgesOf(g) {
  const out = [];
  const seen = new Set();
  for (const [a, nbs] of g.adj) {
    for (const [b, w] of nbs) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b, w });
    }
  }
  for (const [n, w] of g.selfLoops) out.push({ a: n, b: n, w });
  return out;
}

function detectCommunities(repoId) {
  const files = db.prepare(`SELECT id FROM files WHERE repo_id = ? AND deleted = 0`).all(repoId);
  if (files.length === 0) return;

  const rawEdges = db
    .prepare(
      `SELECT e.src_id AS a, e.dst_id AS b, e.weight AS w
       FROM edges e
       JOIN files fa ON fa.id = e.src_id AND fa.deleted = 0
       JOIN files fb ON fb.id = e.dst_id AND fb.deleted = 0
       WHERE e.repo_id = ?`,
    )
    .all(repoId);

  const nodes = files.map((f) => f.id);
  const degree = new Map(nodes.map((n) => [n, 0]));
  for (const e of rawEdges) {
    degree.set(e.a, (degree.get(e.a) || 0) + 1);
    degree.set(e.b, (degree.get(e.b) || 0) + 1);
  }

  let g = buildGraph(rawEdges, nodes);
  let mapping = localMoving(g);

  for (let level = 0; level < 2; level++) {
    const comms = [...new Set(mapping.values())];
    if (comms.length <= 1 || comms.length === g.nodes.length) break;

    const aggEdges = new Map();
    for (const { a, b, w } of rawEdgesOf(g)) {
      const ca = mapping.get(a);
      const cb = mapping.get(b);
      if (ca == null || cb == null) continue;
      const key = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
      const cur = aggEdges.get(key) || { a: ca, b: cb, w: 0 };
      cur.w += w;
      aggEdges.set(key, cur);
    }

    const superGraph = buildGraph([...aggEdges.values()], comms);
    const superMapping = localMoving(superGraph);
    const next = new Map();
    for (const [n, c] of mapping) next.set(n, superMapping.get(c) ?? c);
    if ([...new Set(next.values())].length === comms.length) break;
    mapping = next;
    g = superGraph;
  }

  // Relabel to dense 0..n-1, largest community first, so colour indices are stable-ish.
  const sizes = new Map();
  for (const c of mapping.values()) sizes.set(c, (sizes.get(c) || 0) + 1);
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const relabel = new Map(order.map((c, i) => [c, i]));

  const update = db.prepare(`UPDATE files SET community = ?, degree = ? WHERE id = ?`);
  db.transaction(() => {
    for (const n of nodes) {
      const deg = degree.get(n) || 0;
      // Isolated files get -1 rather than a palette slot of their own.
      const comm = deg === 0 ? -1 : relabel.get(mapping.get(n)) ?? 0;
      update.run(comm, deg, n);
    }
  })();
}

module.exports = { detectCommunities };
