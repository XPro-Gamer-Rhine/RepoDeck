"use strict";

// The error catalogue and the test map.
//
// Both exist for the same reason: an agent asked to fix a bug starts from a
// symptom. The symptom is almost always an error string, a status code, or a
// failing test name — and none of those are searchable in a knowledge graph
// that only describes architecture.
//
// Everything here is extracted from source, line-anchored, verbatim.

const fs = require("node:fs");
const path = require("node:path");
const { db } = require("../db");
const { emit } = require("../events");
const { enclosingSymbol } = require("./symbols");

const ERROR_PATTERNS = [
  // throw new Error("…") / throw new HttpError(404, "…")
  { re: /throw\s+new\s+(\w+)\s*\(\s*(?:\d+\s*,\s*)?['"`]([^'"`]{4,160})['"`]/, kind: "throw", label: 2, type: 1 },
  // throw new Error(`…`) with interpolation — keep the template as written
  { re: /throw\s+new\s+(\w+)\s*\(\s*`([^`]{4,160})`/, kind: "throw", label: 2, type: 1 },
  // res.status(404).json({ error: "…" }) — 4xx and 5xx only. A 201 with a body
  // is a success, and cataloguing it as a failure is worse than missing one.
  { re: /\.status\(\s*([45]\d{2})\s*\)[\s\S]{0,80}?['"`]([^'"`]{4,160})['"`]/, kind: "http-status", label: 2, type: 1 },
  // res.status(404) with no message
  { re: /\.status\(\s*([45]\d{2})\s*\)/, kind: "http-status", label: 1, type: 1 },
  // raise ValueError("…")  ·  abort(404, "…")
  { re: /(?:raise|abort)\s+?\(?\s*(\w+)?\s*\(?\s*['"]([^'"]{4,160})['"]/, kind: "throw", label: 2, type: 1 },
  // PHP: throw new RuntimeException('…')
  { re: /throw\s+new\s+\\?(\w+)\s*\(\s*['"]([^'"]{4,160})['"]/, kind: "throw", label: 2, type: 1 },
];

const TEST_CASE = /(?:^|\s)(?:it|test|describe)\s*\(\s*['"`]([^'"`]{3,160})['"`]/;

const LOOKS_LIKE_SQL = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|PRAGMA|WITH)\b/i;

/**
 * Every failure this codebase can produce, with where it comes from.
 *
 * The point is lookup: paste an error string from a log into a search and land
 * on the function that raised it.
 */
function buildErrorCatalogue(repoId, dir, scanned) {
  const fileMeta = new Map(
    db.prepare(`SELECT path, module FROM files WHERE repo_id = ?`).all(repoId).map((r) => [r.path, r]),
  );

  const insert = db.prepare(
    `INSERT INTO error_catalog (repo_id, kind, label, path, line, symbol, module, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, path, line, label) DO UPDATE SET
       kind = excluded.kind, symbol = excluded.symbol, module = excluded.module,
       evidence = excluded.evidence`,
  );

  // Mark and sweep rather than delete-and-reinsert.
  //
  // The catalogue is extracted statically, but each row also carries a
  // model-written `meaning` that costs a call to produce. Clearing the table
  // first threw all of those away on every re-index — the rows came back
  // identical and unexplained. Now a row that still exists keeps what was
  // written about it, and only rows whose error genuinely disappeared are removed.
  const seenIds = new Set();
  const findExisting = db.prepare(
    `SELECT id FROM error_catalog WHERE repo_id = ? AND path = ? AND line = ? AND label = ?`,
  );

  let found = 0;
  db.transaction(() => {

    for (const file of scanned) {
      let source;
      try {
        source = fs.readFileSync(path.join(dir, file.path), "utf8");
      } catch {
        continue;
      }
      const lines = source.split("\n");
      const declared = [...(file.symbols || [])].sort((a, b) => a.line - b.line);
      const meta = fileMeta.get(file.path) || {};
      const seen = new Set();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.length > 400) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

        for (const rule of ERROR_PATTERNS) {
          const m = line.match(rule.re);
          if (!m) continue;
          const label = (m[rule.label] || "").trim();
          if (!label) continue;
          // The status-plus-string pattern reaches across the rest of the line,
          // so on `res.status(201).json(db.prepare(`SELECT …`))` it grabs the
          // query. A query is not an error message.
          if (LOOKS_LIKE_SQL.test(label)) continue;
          const key = `${i + 1}|${label}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const owner = enclosingSymbol(declared, i + 1);
          const stored = label.slice(0, 200);
          insert.run(
            repoId,
            rule.kind,
            stored,
            file.path,
            i + 1,
            owner ? owner.name : null,
            meta.module || null,
            trimmed.slice(0, 240),
          );
          const row = findExisting.get(repoId, file.path, i + 1, stored);
          if (row) seenIds.add(row.id);
          found++;
          break;
        }
      }
    }

    // Sweep: anything not re-found this pass no longer exists in the source.
    const stale = db
      .prepare(`SELECT id FROM error_catalog WHERE repo_id = ?`)
      .all(repoId)
      .filter((r) => !seenIds.has(r.id));
    const remove = db.prepare(`DELETE FROM error_catalog WHERE id = ?`);
    for (const r of stale) remove.run(r.id);
  })();

  const explained = db
    .prepare(`SELECT COUNT(*) AS n FROM error_catalog WHERE repo_id = ? AND meaning IS NOT NULL`)
    .get(repoId).n;
  emit({ t: "errors_catalogued", repoId, errors: found, explained });
  return { errors: found, explained };
}

/**
 * Which test file covers which source file, and what it asserts.
 *
 * Derived from what the test imports — the only evidence available without
 * running anything — plus the names of its cases, which are usually the clearest
 * statement of intended behaviour in the whole repository.
 */
function buildTestMap(repoId, dir, scanned, resolvedImports) {
  const testFiles = scanned.filter(
    (f) => /(^|\/)(tests?|spec|__tests__|e2e)\//.test(f.path) || /\.(test|spec)\./.test(f.path),
  );

  const insert = db.prepare(
    `INSERT INTO test_map (repo_id, test_path, covers_path, cases)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo_id, test_path, covers_path) DO UPDATE SET cases = excluded.cases`,
  );

  let pairs = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM test_map WHERE repo_id = ?`).run(repoId);

    for (const file of testFiles) {
      let source = "";
      try {
        source = fs.readFileSync(path.join(dir, file.path), "utf8");
      } catch {
        continue;
      }

      const cases = [];
      for (const line of source.split("\n")) {
        const m = line.match(TEST_CASE);
        if (m && cases.length < 60) cases.push(m[1]);
      }

      const covered = (resolvedImports.get(file.path) || []).filter(
        (target) => !/(^|\/)(tests?|spec|__tests__)\//.test(target),
      );
      for (const target of covered) {
        insert.run(repoId, file.path, target, JSON.stringify(cases));
        pairs++;
      }
    }
  })();

  emit({ t: "tests_mapped", repoId, testFiles: testFiles.length, pairs });
  return { testFiles: testFiles.length, pairs };
}

function listErrors(repoId, limit = 400) {
  return db
    .prepare(
      `SELECT kind, label, path, line, symbol, module, evidence, meaning
       FROM error_catalog WHERE repo_id = ? ORDER BY module, path, line LIMIT ?`,
    )
    .all(repoId, limit);
}

function listTestMap(repoId) {
  const rows = db
    .prepare(`SELECT test_path, covers_path, cases FROM test_map WHERE repo_id = ?`)
    .all(repoId);
  const byCovered = new Map();
  for (const r of rows) {
    if (!byCovered.has(r.covers_path)) byCovered.set(r.covers_path, { path: r.covers_path, tests: [] });
    byCovered.get(r.covers_path).tests.push({
      path: r.test_path,
      cases: JSON.parse(r.cases || "[]"),
    });
  }
  return [...byCovered.values()];
}

module.exports = { buildErrorCatalogue, buildTestMap, listErrors, listTestMap };
