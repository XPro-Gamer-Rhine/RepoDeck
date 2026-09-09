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
    const committedAt = Date.parse(r.committed_at);
    // Date.parse returns NaN for anything it cannot read, and NaN propagates
    // through the decay into every file's heat — which then goes into a REAL
    // NOT NULL column as null-ish garbage. Treat an unreadable timestamp as old.
    if (!Number.isFinite(committedAt)) continue;
    const ageDays = Math.max(0, (now - committedAt) / 86_400_000);
    const weight = Math.exp(-lambda * ageDays);
    const cur = agg.get(r.path) || { raw: 0, count: 0, last: r.committed_at };
    cur.raw += (1 + Math.log1p(r.size)) * weight;
    cur.count += 1;
    if (r.committed_at > cur.last) cur.last = r.committed_at;
    agg.set(r.path, cur);
  }

  // A fold, not a spread. Math.max(...array) passes every element as an argument
  // and throws RangeError past roughly 130k of them — and `agg` is keyed by every
  // path the repository's merge history has ever touched, which a long-lived
  // monorepo clears easily.
  let max = 0.000001;
  for (const v of agg.values()) if (v.raw > max) max = v.raw;

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
