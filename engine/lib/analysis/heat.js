"use strict";

const { db } = require("../db");
const { config } = require("../config");

/**
 * Heat = time-decayed churn. A file touched by ten merges last week outranks
 * one touched by forty merges two years ago. Decay is exponential with a
 * configurable half-life; the stored value is normalised 0..1 within the repo
 * so the colour ramp is comparable across repos of different ages.
 */
function recomputeHeat(repoId) {
  const halfLife = Math.max(1, config.limits.heatHalfLifeDays);
  const lambda = Math.LN2 / halfLife;
  const now = Date.now();

  const rows = db
    .prepare(
      `SELECT fc.path AS path,
              fc.additions + fc.deletions AS size,
              c.committed_at AS committed_at
       FROM file_changes fc
       JOIN commits c ON c.id = fc.commit_id
       WHERE fc.repo_id = ?`,
    )
    .all(repoId);

  const agg = new Map();
  for (const r of rows) {
    const ageDays = Math.max(0, (now - Date.parse(r.committed_at)) / 86_400_000);
    const weight = Math.exp(-lambda * ageDays);
    const cur = agg.get(r.path) || { raw: 0, count: 0, last: r.committed_at };
    cur.raw += (1 + Math.log1p(r.size)) * weight;
    cur.count += 1;
    if (r.committed_at > cur.last) cur.last = r.committed_at;
    agg.set(r.path, cur);
  }

  const max = Math.max(...[...agg.values()].map((v) => v.raw), 0.000001);

  const churnByPath = db
    .prepare(
      `SELECT path, SUM(additions + deletions) AS churn FROM file_changes WHERE repo_id = ? GROUP BY path`,
    )
    .all(repoId);
  const churnMap = new Map(churnByPath.map((c) => [c.path, c.churn]));

  const reset = db.prepare(
    `UPDATE files SET heat = 0, commit_count = 0, churn = 0, last_change_at = NULL WHERE repo_id = ?`,
  );
  const update = db.prepare(
    `UPDATE files SET heat = ?, commit_count = ?, churn = ?, last_change_at = ? WHERE repo_id = ? AND path = ?`,
  );

  db.transaction(() => {
    reset.run(repoId);
    for (const [p, v] of agg) {
      update.run(v.raw / max, v.count, churnMap.get(p) || 0, v.last, repoId, p);
    }
  })();
}

module.exports = { recomputeHeat };
