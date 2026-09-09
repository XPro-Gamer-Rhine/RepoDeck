"use strict";

// The passes that turn an architecture map into something an agent can act on.
//
// Everything static is already in place: symbols, call chains, errors, tests.
// What is missing is the part only a reader of the code can supply — what a
// function is *for*, what it assumes, what it breaks if you get it wrong, and
// what to check when a given symptom shows up.
//
// These are the expensive passes, so they are bounded: the functions that matter
// are the ones on real call chains, not every helper in the repository.

const fs = require("node:fs");
const path = require("node:path");
const { db, json: parseJson } = require("../db");
const { config } = require("../config");
const providers = require("../providers");
const { emit, progress } = require("../events");
const { chunk } = require("./map");

// ── function contracts ───────────────────────────────────────────────────────

const CONTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["functions"],
  properties: {
    functions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "path", "purpose", "returns", "sideEffects", "throws", "preconditions"],
        properties: {
          name: { type: "string" },
          path: { type: "string" },
          purpose: { type: "string" },
          returns: { type: "string" },
          sideEffects: { type: "array", items: { type: "string" } },
          throws: { type: "array", items: { type: "string" } },
          preconditions: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/** The source of one function, from its declaration to the next one. */
function sliceFunction(dir, filePath, line, allLinesForFile, budget = 3200) {
  const lines = allLinesForFile;
  if (!lines) return "";
  const start = Math.max(0, line - 1);
  const end = Math.min(lines.length, start + 90);
  return lines.slice(start, end).join("\n").slice(0, budget);
}

/**
 * Describe the functions that carry the application.
 *
 * Ranked by how connected they are, because a function twelve things call is
 * one an agent will meet; a one-line formatter is not. Bounded so this stays
 * affordable on a large repository.
 */
async function enrichSymbols(cfg, repoId, dir, opts = {}) {
  const limit = opts.limit ?? 250;

  // Worth a contract: anything other code reaches (connected), and anything the
  // module offers to the outside (exported). Type aliases are excluded — a
  // contract for a type restates the type — and so are tests.
  //
  // Resumable: symbols that already have a purpose are skipped unless forced, so
  // an interrupted run resumes instead of paying for the same functions twice.
  const targets = db
    .prepare(
      `SELECT s.id, s.path, s.name, s.kind, s.line, s.signature, s.params,
              (s.in_degree + s.out_degree) AS degree
       FROM symbols s
       JOIN files f ON f.repo_id = s.repo_id AND f.path = s.path
       WHERE s.repo_id = ? AND s.deleted = 0 AND f.deleted = 0 AND f.layer != 'test'
         AND s.kind NOT IN ('type', 'module')
         AND ((s.in_degree + s.out_degree) > 0 OR s.exported = 1)
         AND (? = 1 OR s.purpose IS NULL)
       ORDER BY degree DESC, s.exported DESC
       LIMIT ?`,
    )
    .all(repoId, opts.force ? 1 : 0, limit);

  if (targets.length === 0) return { described: 0, remaining: 0 };

  // Read each file once, however many of its functions are in the batch.
  const sourceCache = new Map();
  const linesFor = (filePath) => {
    if (!sourceCache.has(filePath)) {
      try {
        sourceCache.set(filePath, fs.readFileSync(path.join(dir, filePath), "utf8").split("\n"));
      } catch {
        sourceCache.set(filePath, null);
      }
    }
    return sourceCache.get(filePath);
  };

  const update = db.prepare(
    `UPDATE symbols SET purpose = ?, returns = ?, side_effects = ?, throws = ?
     WHERE repo_id = ? AND path = ? AND name = ?`,
  );

  let described = 0;
  const results = await providers.pool(
    chunk(targets, 8),
    config.limits.maxConcurrency,
    (batch) =>
      providers.askJson(cfg, {
        system: `Write the contract for each function you are shown, for an agent that will have to
call it or change it without reading the whole file.

- purpose: what it does, one sentence, specific to this function. Not "handles data".
- returns: the shape it returns, written compactly ("{ ok: boolean, conflicts: string[] }"),
  or "nothing" / "a Promise that resolves when the write completes".
- sideEffects: what it changes outside its own return value — writes to a table, spawns a process,
  mutates an argument, sends a request, touches the filesystem, emits an event. Empty array if pure.
- throws: the failure cases, each as the condition that causes it. Empty array if it cannot throw.
- preconditions: what must already be true before calling it — an open transaction, a cloned
  repository, an unlocked credential, a validated payload. Empty array if it has none.

Only state what the source supports. An empty array is a fine answer; an invented side effect is not.`,
        user: JSON.stringify(
          batch.map((t) => ({
            name: t.name,
            path: t.path,
            kind: t.kind,
            signature: t.signature,
            source: sliceFunction(dir, t.path, t.line, linesFor(t.path)),
          })),
        ),
        schema: CONTRACT_SCHEMA,
        effort: "medium",
      }),
    (done, total) => progress("kg", `Function contracts: ${done}/${total} batches`, { repoId }),
  );

  // Only the functions that were actually asked about may be written. The model
  // returns path+name pairs, and one it invented — or copied from an example —
  // would otherwise overwrite a correct contract belonging to a different
  // function that happens to match.
  const asked = new Set(targets.map((t) => `${t.path}\u0000${t.name}`));

  db.transaction(() => {
    for (const r of results) {
      if (!r || r.error) continue;
      for (const fn of r.functions || []) {
        if (!asked.has(`${fn.path}\u0000${fn.name}`)) continue;
        update.run(
          fn.purpose || null,
          fn.returns || null,
          JSON.stringify(fn.sideEffects || []),
          JSON.stringify([...(fn.throws || []), ...(fn.preconditions || []).map((p) => `requires: ${p}`)]),
          repoId,
          fn.path,
          fn.name,
        );
        described++;
      }
    }
  })();

  const remaining = db
    .prepare(
      `SELECT COUNT(*) AS n FROM symbols s
       JOIN files f ON f.repo_id = s.repo_id AND f.path = s.path
       WHERE s.repo_id = ? AND s.deleted = 0 AND f.deleted = 0 AND f.layer != 'test'
         AND s.kind NOT IN ('type', 'module')
         AND ((s.in_degree + s.out_degree) > 0 OR s.exported = 1)
         AND s.purpose IS NULL`,
    )
    .get(repoId).n;

  return { described, remaining };
}

// ── failure playbooks ────────────────────────────────────────────────────────

const PLAYBOOK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["playbooks", "invariants"],
  properties: {
    playbooks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["symptom", "likelyCause", "checkFirst", "fixPattern", "verify"],
        properties: {
          symptom: { type: "string" },
          likelyCause: { type: "string" },
          checkFirst: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "what"],
              properties: { path: { type: "string" }, what: { type: "string" } },
            },
          },
          fixPattern: { type: "string" },
          verify: { type: "string" },
        },
      },
    },
    invariants: { type: "array", items: { type: "string" } },
  },
};

/**
 * "If this breaks, look here."
 *
 * The single most useful thing to hand an agent that is asked to fix something,
 * and the thing an architecture diagram cannot express. Grounded in the module's
 * real errors and real call chains so the paths it names exist.
 */
async function buildPlaybooks(cfg, repoId, opts = {}) {
  let modules = db
    .prepare(
      `SELECT module, COUNT(*) AS files FROM files
       WHERE repo_id = ? AND deleted = 0 AND module IS NOT NULL AND module != ''
       GROUP BY module ORDER BY files DESC`,
    )
    .all(repoId);

  // Resumable: skip modules that already have a playbook unless asked to redo
  // them, and allow a slice. A long repository should not have to start over
  // because one run was interrupted.
  if (!opts.force) {
    // Resumable, but not permanent. Skipping every module that already has a
    // playbook meant one was written once and then kept naming files and error
    // strings the module no longer had, for the life of the repository. A
    // playbook is fresh only while the module it describes has not moved since.
    const written = new Map(
      db
        .prepare(`SELECT key, updated_at FROM kg_docs WHERE repo_id = ? AND kind = 'playbook'`)
        .all(repoId)
        .map((r) => [r.key, r.updated_at]),
    );
    const lastChange = new Map(
      db
        .prepare(
          `SELECT module, MAX(last_change_at) AS changed
             FROM files
            WHERE repo_id = ? AND deleted = 0 AND module IS NOT NULL AND module != ''
            GROUP BY module`,
        )
        .all(repoId)
        .map((r) => [r.module, r.changed]),
    );
    modules = modules.filter((m) => {
      const doc = written.get(m.module);
      if (!doc) return true;                       // never written
      const changed = lastChange.get(m.module);
      if (!changed) return false;                  // nothing to compare against
      return changed > doc;                        // ISO-8601 strings sort chronologically
    });
  }
  if (opts.only && opts.only.length) modules = modules.filter((m) => opts.only.includes(m.module));
  if (opts.limit) modules = modules.slice(0, opts.limit);

  if (modules.length === 0) return { playbooks: 0, remaining: 0 };

  const put = db.prepare(
    `INSERT INTO kg_docs (repo_id, kind, key, title, body, updated_at)
     VALUES (?, 'playbook', ?, ?, ?, datetime('now'))
     ON CONFLICT(repo_id, kind, key) DO UPDATE SET
       title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
  );

  let written = 0;
  const results = await providers.pool(
    modules,
    config.limits.maxConcurrency,
    async (m) => {
      const files = db
        .prepare(
          `SELECT path, layer, role, summary FROM files
           WHERE repo_id = ? AND module = ? AND deleted = 0 ORDER BY degree DESC LIMIT 40`,
        )
        .all(repoId, m.module);

      const errors = db
        .prepare(
          `SELECT kind, label, path, line, symbol FROM error_catalog
           WHERE repo_id = ? AND module = ? LIMIT 40`,
        )
        .all(repoId, m.module);

      const functions = db
        .prepare(
          `SELECT name, path, line, purpose, side_effects, throws FROM symbols
           WHERE repo_id = ? AND module = ? AND deleted = 0 AND purpose IS NOT NULL
           ORDER BY (in_degree + out_degree) DESC LIMIT 30`,
        )
        .all(repoId, m.module);

      const flows = db
        .prepare(`SELECT key, entry_path, steps FROM flows WHERE repo_id = ? AND module = ? LIMIT 12`)
        .all(repoId, m.module);

      const brief = await providers.askJson(cfg, {
        system: `Write the debugging playbook for one module, for an agent asked to fix a problem in it.

Each playbook entry is a symptom a person would actually report — an error string from a log, a
wrong result, a hang, a failed deploy — not an abstract category.

- symptom: how it presents. Quote the real error text when the catalogue has one.
- likelyCause: the mechanism, in terms of this code. Name the function.
- checkFirst: 2-4 files to open, in order, each with what to look at in that file. Use exact paths
  from the material shown.
- fixPattern: what a correct fix looks like here — the shape of the change, not pseudocode.
- verify: how to confirm it is fixed. Name a test, a command, or an observable behaviour.

Then list invariants: things that must stay true of this module. An agent that breaks one of these
has broken the module even if the tests pass. Be concrete and specific to this code.

Six to ten playbook entries. Ground every path in what you were shown; do not invent files.`,
        user: `Module "${m.module}" (${m.files} files)

Files:
${files.map((f) => `- ${f.path} [${f.layer}] ${f.role || ""}`).join("\n")}

Errors this module can raise:
${errors.map((e) => `- ${e.path}:${e.line} (${e.symbol || "?"}) [${e.kind}] "${e.label}"`).join("\n") || "(none catalogued)"}

Key functions:
${functions
  .map(
    (fn) =>
      `- ${fn.name}() ${fn.path}:${fn.line} — ${fn.purpose || ""}` +
      `${fn.side_effects && fn.side_effects !== "[]" ? ` · side effects: ${fn.side_effects}` : ""}` +
      `${fn.throws && fn.throws !== "[]" ? ` · throws: ${fn.throws}` : ""}`,
  )
  .join("\n") || "(none described)"}

Traced request paths:
${flows
  .map((f) => {
    const steps = parseJson(f.steps, []);
    return `- ${f.key} (${f.entry_path}) → ${steps.map((s) => `${s.name}() ${s.path}:${s.line}`).join(" → ") || "(no further calls)"}`;
  })
  .join("\n") || "(none traced)"}`,
        schema: PLAYBOOK_SCHEMA,
        effort: "high",
      });

      return { module: m.module, ...brief };
    },
    (done, total) => progress("kg", `Playbooks: ${done}/${total}`, { repoId }),
  );

  for (const r of results) {
    if (!r || r.error) continue;
    // A response that parsed but said nothing is not a playbook. Storing it
    // filled the slot, and the resume filter above then skipped that module
    // forever — one bad call permanently cost the repository a playbook.
    const hasContent = (Array.isArray(r.playbooks) && r.playbooks.length > 0)
      || (Array.isArray(r.invariants) && r.invariants.length > 0);
    if (!hasContent) {
      emit({ t: "playbook_empty", repoId, module: r.module });
      continue;
    }
    put.run(repoId, r.module, `Playbook: ${r.module}`, JSON.stringify(r));
    written++;
  }

  const remaining = db
    .prepare(
      `SELECT COUNT(DISTINCT module) AS n FROM files
       WHERE repo_id = ? AND deleted = 0 AND module IS NOT NULL AND module != ''
         AND module NOT IN (SELECT key FROM kg_docs WHERE repo_id = ? AND kind = 'playbook')`,
    )
    .get(repoId, repoId).n;

  return { playbooks: written, remaining };
}

// ── error meanings ───────────────────────────────────────────────────────────

const MEANINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["errors"],
  properties: {
    errors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "line", "meaning"],
        properties: {
          path: { type: "string" },
          line: { type: "number" },
          meaning: { type: "string" },
        },
      },
    },
  },
};

/**
 * What each error actually means and what to check when it appears.
 *
 * Turns the catalogue from a list of strings into something you can paste a log
 * line into and get an answer from.
 */
async function explainErrors(cfg, repoId, opts = {}) {
  const rows = db
    .prepare(
      `SELECT kind, label, path, line, symbol, evidence FROM error_catalog
       WHERE repo_id = ? AND meaning IS NULL LIMIT ?`,
    )
    .all(repoId, opts.limit ?? 150);
  if (rows.length === 0) return { explained: 0 };

  const update = db.prepare(
    `UPDATE error_catalog SET meaning = ? WHERE repo_id = ? AND path = ? AND line = ?`,
  );

  let explained = 0;
  const results = await providers.pool(
    chunk(rows, 20),
    config.limits.maxConcurrency,
    (batch) =>
      providers.askJson(cfg, {
        system: `For each error this codebase can raise, write what it means and what to check.

One or two sentences. Say what condition produced it and the first thing a developer should look at.
Write it so that someone who pasted this error out of a log knows what to do next. Be specific to
the function it comes from; do not restate the message.`,
        user: JSON.stringify(
          batch.map((r) => ({
            path: r.path,
            line: r.line,
            kind: r.kind,
            message: r.label,
            raisedIn: r.symbol,
            source: r.evidence,
          })),
        ),
        schema: MEANINGS_SCHEMA,
        effort: "low",
      }),
    (done, total) => progress("kg", `Error meanings: ${done}/${total} batches`, { repoId }),
  );

  db.transaction(() => {
    for (const r of results) {
      if (!r || r.error) continue;
      for (const e of r.errors || []) {
        update.run(e.meaning, repoId, e.path, e.line);
        explained++;
      }
    }
  })();

  return { explained };
}

module.exports = { enrichSymbols, buildPlaybooks, explainErrors };
