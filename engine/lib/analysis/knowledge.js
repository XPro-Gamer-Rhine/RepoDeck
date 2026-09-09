"use strict";

// The knowledge graph.
//
// The architecture graph answers "what is connected to what". The knowledge
// graph answers the questions an agent actually has before it can change
// anything: what does this repo do, which screen talks to which endpoint, what
// payload does that endpoint expect, what comes back, what changed last week,
// and how do I run it.
//
// It is built in focused passes, each with its own strict schema and each fed
// real source rather than summaries of summaries. Every pass is independent, so
// a failure in one leaves the rest of the graph intact.

const { db, json: parseJson } = require("../db");
const { config } = require("../config");
const providers = require("../providers");
const { chunk } = require("./map");
const { progress } = require("../events");
const { enrichSymbols, buildPlaybooks, explainErrors } = require("./deepen");
const { listFlows } = require("./flows");
const { listErrors, listTestMap } = require("./failures");

// ── shared schema fragments ──────────────────────────────────────────────────
// Structured-output modes require every declared property to be present, so
// "unknown" is expressed as an empty string or an empty array, never a missing key.

const FIELD = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type", "required", "note"],
  properties: {
    name: { type: "string" },
    type: { type: "string" },
    required: { type: "boolean" },
    note: { type: "string" },
  },
};

// ── 1. overview ──────────────────────────────────────────────────────────────

const OVERVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "purpose", "elevatorPitch", "stack", "architecture", "entryPoints",
    "commands", "conventions", "gotchas", "glossary",
  ],
  properties: {
    purpose: { type: "string" },
    elevatorPitch: { type: "string" },
    stack: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "role", "version"],
        properties: { name: { type: "string" }, role: { type: "string" }, version: { type: "string" } },
      },
    },
    architecture: { type: "string" },
    entryPoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "what"],
        properties: { path: { type: "string" }, what: { type: "string" } },
      },
    },
    commands: {
      type: "object",
      additionalProperties: false,
      required: ["install", "dev", "build", "test", "lint", "migrate"],
      properties: {
        install: { type: "string" },
        dev: { type: "string" },
        build: { type: "string" },
        test: { type: "string" },
        lint: { type: "string" },
        migrate: { type: "string" },
      },
    },
    conventions: { type: "array", items: { type: "string" } },
    gotchas: { type: "array", items: { type: "string" } },
    glossary: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "meaning"],
        properties: { term: { type: "string" }, meaning: { type: "string" } },
      },
    },
  },
};

async function buildOverview(cfg, ctx) {
  const { repo, manifests, taxonomy, layerCounts, topDirs, hotFiles } = ctx;

  const manifestDigest = JSON.stringify(
    {
      node: manifests.node || null,
      php: manifests.php || null,
      compose: manifests.compose ? manifests.compose.body.slice(0, 3000) : null,
      dockerfile: manifests.dockerfile ? manifests.dockerfile.body.slice(0, 1500) : null,
      procfile: manifests.procfile ? manifests.procfile.body : null,
      makefile: manifests.makefile ? manifests.makefile.body.slice(0, 2000) : null,
      pyproject: manifests.pyproject ? manifests.pyproject.body.slice(0, 2000) : null,
      gomod: manifests.gomod ? manifests.gomod.body.slice(0, 1000) : null,
      lockfiles: manifests.lockfiles,
    },
    null,
    1,
  ).slice(0, 12_000);

  return providers.askJson(cfg, {
    system: `You are writing the top of a knowledge base that a coding agent will read before it
touches this repository. Be concrete and specific to THIS codebase — never generic advice.

- purpose: what the software does, for whom, in 1-2 sentences.
- elevatorPitch: one line, under 20 words.
- stack: the frameworks, runtimes, databases and notable libraries actually in use. Version only if
  you can read it from a manifest; otherwise empty string.
- architecture: how the pieces fit together — layers, processes, data flow. 3-6 sentences.
- entryPoints: files where execution begins (server bootstrap, CLI, app root, worker).
- commands: exact shell commands, copied from the manifests where they exist. Empty string when
  the repo genuinely has none. Never invent a command.
- conventions: rules a contributor must follow that are visible in this codebase
  (naming, folder meaning, error handling, testing style). 4-8 items.
- gotchas: things that would trip up someone changing this code. 3-6 items.
- glossary: domain terms this codebase uses that an outsider would not know.

Everything you state must be supported by the material shown to you.`,
    user: `Repository: ${repo.name} (${repo.url}), branch ${repo.default_branch}

Manifests:
${manifestDigest}

README (head):
${manifests.readme ? manifests.readme.body.slice(0, 8000) : "(none)"}

${manifests.claudeMd ? `Existing CLAUDE.md:\n${manifests.claudeMd.body.slice(0, 4000)}\n` : ""}
Feature modules the mapper agreed on:
${taxonomy.map((t) => `- ${t.name}: ${t.description}`).join("\n") || "(none)"}

File counts by layer: ${JSON.stringify(layerCounts)}
Top-level directories: ${topDirs.join(", ")}

Files changing most right now:
${hotFiles.map((f) => `- ${f.path} — ${f.role || "?"} (churn ${f.churn})`).join("\n")}`,
    schema: OVERVIEW_SCHEMA,
    effort: "high",
  });
}

// ── 2. API surface ───────────────────────────────────────────────────────────

const ENDPOINTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["endpoints"],
  properties: {
    endpoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "method", "path", "handlerPath", "handlerSymbol", "auth", "middleware",
          "pathParams", "queryParams", "bodyFields", "responseSuccess", "responseErrors",
          "statusCodes", "summary", "evidence",
        ],
        properties: {
          method: { type: "string" },
          path: { type: "string" },
          handlerPath: { type: "string" },
          handlerSymbol: { type: "string" },
          auth: { type: "string" },
          middleware: { type: "array", items: { type: "string" } },
          pathParams: { type: "array", items: FIELD },
          queryParams: { type: "array", items: FIELD },
          bodyFields: { type: "array", items: FIELD },
          responseSuccess: { type: "string" },
          responseErrors: { type: "array", items: { type: "string" } },
          statusCodes: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

/**
 * Narrow a pass's candidate list to what is worth paying for.
 *
 * Two independent problems, one place to solve them.
 *
 * On an incremental sync the passes were handed the entire tree, so an hourly
 * auto-pull re-extracted the whole API surface every hour even when one file
 * had moved. `changedPaths` cuts that to the files this sync actually touched;
 * the rows for everything else stay in the database untouched.
 *
 * And even a full run needs a ceiling: nothing bounded the number of batches,
 * so a large repository fanned out into hundreds of calls. Ranking by
 * connectedness and recency first means the cap keeps the files that carry the
 * architecture and drops the long tail.
 */
function selectCandidates(ctx, pass, candidates, cap) {
  let selected = candidates;

  const changed = ctx.changedPaths;
  if (changed && changed.size > 0 && !ctx.full) {
    const delta = selected.filter((f) => changed.has(f.path));
    // If nothing this pass cares about changed, there is nothing to re-extract.
    selected = delta;
  }

  if (selected.length > cap) {
    const rank = (f) =>
      (f.routeLines?.length || 0) * 4 + (f.hints?.length || 0) * 2 + (f.exports?.length || 0);
    selected = [...selected].sort((a, b) => rank(b) - rank(a)).slice(0, cap);
    progress("kg", `Capped this pass at ${cap} files — the rest are the long tail`);
  }

  // Record exactly which files this pass looked at. The save step deletes only
  // the rows those files own, so a scoped run replaces what it re-derived and
  // leaves the rest of the graph alone.
  ctx.processedBy = ctx.processedBy || {};
  ctx.processedBy[pass] = new Set(selected.map((f) => f.path));
  return selected;
}

async function buildEndpoints(cfg, ctx, onProgress) {
  const { scanned, resolvedImports } = ctx;

  // Only files that plausibly declare or handle requests. Sending the whole tree
  // through this pass would triple the bill for nothing.
  const candidates = selectCandidates(
    ctx,
    "endpoints",
    scanned.filter(
      (f) =>
        f.routeLines.length > 0 ||
        f.hints.includes("declares-routes") ||
        f.hints.includes("controller-class") ||
        ["route", "controller"].includes(ctx.layerOf.get(f.path)),
    ),
    config.limits.kgMaxFilesPerPass,
  );
  if (candidates.length === 0) return [];

  const batches = chunk(candidates, 6);
  const results = await providers.pool(
    batches,
    config.limits.maxConcurrency,
    (batch) =>
      providers.askJson(cfg, {
        system: `Extract the HTTP/RPC API surface from these files, for an agent that must CALL or
CHANGE these endpoints without reading the code first.

For every endpoint you can prove exists:
- method: uppercase verb, or "RPC"/"WS" for non-HTTP transports.
- path: the full path as the client sees it, including any router prefix visible in the source.
  Keep the framework's parameter syntax (/users/:id, /users/{id}).
- handlerPath: exact repository path of the file containing the handler body. Use one of the paths
  shown to you; empty string if it is not among them.
- handlerSymbol: the function or method name.
- auth: what the endpoint requires ("bearer token", "session cookie", "none"). Empty if unclear.
- middleware: named middleware/guards applied, in order.
- pathParams / queryParams / bodyFields: the payload the endpoint EXPECTS. Take types from
  validators, DTOs, schemas or destructuring in the source. Mark required accurately.
- responseSuccess: the success body's shape, written as compact pseudo-JSON
  ("{ id: string, items: Array<{ sku: string, qty: number }> }").
- responseErrors: error shapes or messages the handler can return.
- statusCodes: status codes the handler actually sets.
- summary: one sentence on what the endpoint does.
- evidence: a VERBATIM line from one of the files shown, proving the route exists.

Rules: never invent an endpoint, a field or a path. If a payload is not visible in the source,
return an empty array rather than a guess. Accuracy beats coverage.`,
        user: JSON.stringify(
          batch.map((f) => ({
            path: f.path,
            resolvedImports: resolvedImports.get(f.path) || [],
            routeWiring: f.routeLines,
            source: f.head,
          })),
        ),
        schema: ENDPOINTS_SCHEMA,
        effort: "high",
      }),
    onProgress,
  );

  const out = [];
  let failed = 0;
  for (const r of results) {
    if (!r || r.error) {
      failed++;
      continue;
    }
    out.push(...(r.endpoints || []));
  }
  // A batch that failed produced no rows, and deleting the rows it WOULD have
  // produced is how a bad afternoon on the API turns into "this repository has
  // no endpoints" — stated as fact in the exported document. The count travels
  // with the result so the save step can decline to clear anything.
  out.failedBatches = failed;
  return out;
}

// ── 3. data models ───────────────────────────────────────────────────────────

const ENTITIES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entities"],
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "filePath", "store", "fields", "relations", "summary"],
        properties: {
          name: { type: "string" },
          filePath: { type: "string" },
          store: { type: "string" },
          fields: { type: "array", items: FIELD },
          relations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["to", "kind", "via"],
              properties: {
                to: { type: "string" },
                kind: { type: "string", enum: ["has-one", "has-many", "belongs-to", "many-to-many", "embeds"] },
                via: { type: "string" },
              },
            },
          },
          summary: { type: "string" },
        },
      },
    },
  },
};

async function buildEntities(cfg, ctx, onProgress) {
  const candidates = selectCandidates(
    ctx,
    "entities",
    ctx.scanned.filter(
      (f) => f.hints.includes("data-model") || ctx.layerOf.get(f.path) === "model",
    ),
    config.limits.kgMaxFilesPerPass,
  );
  if (candidates.length === 0) return [];

  const results = await providers.pool(
    chunk(candidates, 8),
    config.limits.maxConcurrency,
    (batch) =>
      providers.askJson(cfg, {
        system: `Extract the DATA MODELS these files declare — entities that are persisted or
transferred over the API.

Include: ORM models and entities, database table/collection schemas, migration-defined tables,
request/response DTOs that cross the API boundary, and validation schemas for those.

Exclude: internal type aliases, enums, option/config interfaces, function-argument shapes, and
any type that exists only to describe a local function signature. If a type is never stored and
never crosses a network boundary, leave it out — a data model list padded with option-bags and
enums is worse than a short accurate one.

- name: the model/entity/table name as code refers to it.
- filePath: exact repository path from the list shown.
- store: the physical table or collection name, when the source names one.
- fields: every declared field with its type, whether it is required, and a short note for anything
  non-obvious (enums, defaults, indexes, encryption).
- relations: links to other models, with the foreign key or join in "via".
- summary: one sentence on what the entity represents.

Only report what is written in the source. No inferred fields.`,
        user: JSON.stringify(batch.map((f) => ({ path: f.path, source: f.head }))),
        schema: ENTITIES_SCHEMA,
        effort: "medium",
      }),
    onProgress,
  );

  const out = [];
  let failed = 0;
  for (const r of results) {
    if (!r || r.error) {
      failed++;
      continue;
    }
    out.push(...(r.entities || []));
  }
  // A batch that failed produced no rows, and deleting the rows it WOULD have
  // produced is how a bad afternoon on the API turns into "this repository has
  // no entities" — stated as fact in the exported document. The count travels
  // with the result so the save step can decline to clear anything.
  out.failedBatches = failed;
  return out;
}

// ── 4. screens and their wiring ──────────────────────────────────────────────

const SCREENS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["screens"],
  properties: {
    screens: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "route", "filePath", "components", "calls", "state", "summary"],
        properties: {
          name: { type: "string" },
          route: { type: "string" },
          filePath: { type: "string" },
          components: { type: "array", items: { type: "string" } },
          calls: { type: "array", items: { type: "string" } },
          state: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
        },
      },
    },
  },
};

async function buildScreens(cfg, ctx, onProgress) {
  const candidates = selectCandidates(
    ctx,
    "screens",
    ctx.scanned.filter(
      (f) => ["page", "component"].includes(ctx.layerOf.get(f.path)) || f.hints.includes("page-or-view"),
    ),
    config.limits.kgMaxFilesPerPass,
  );
  if (candidates.length === 0) return [];

  const results = await providers.pool(
    chunk(candidates, 8),
    config.limits.maxConcurrency,
    (batch) =>
      providers.askJson(cfg, {
        system: `Map the user-facing surface: which screen is connected to what.

For each screen or significant view:
- name: how the team refers to it.
- route: the client-side URL it renders at, if the source shows one.
- filePath: exact repository path from the list shown.
- components: repository paths of the components it composes — only ones present in the resolved
  imports you are given.
- calls: the API calls it makes, each as "METHOD /path" (e.g. "POST /api/orders"). Take these from
  the outbound call lines and the source. Empty array if none are visible.
- state: named stores, contexts or query keys it reads or writes.
- summary: one sentence on what the user does here.

Skip pure presentational leaf components with no route, no calls and no state.`,
        user: JSON.stringify(
          batch.map((f) => ({
            path: f.path,
            resolvedImports: ctx.resolvedImports.get(f.path) || [],
            outboundCalls: f.callLines,
            source: f.head,
          })),
        ),
        schema: SCREENS_SCHEMA,
        effort: "medium",
      }),
    onProgress,
  );

  const out = [];
  let failed = 0;
  for (const r of results) {
    if (!r || r.error) {
      failed++;
      continue;
    }
    out.push(...(r.screens || []));
  }
  // A batch that failed produced no rows, and deleting the rows it WOULD have
  // produced is how a bad afternoon on the API turns into "this repository has
  // no screens" — stated as fact in the exported document. The count travels
  // with the result so the save step can decline to clear anything.
  out.failedBatches = failed;
  return out;
}

// ── 5. per-module briefs ─────────────────────────────────────────────────────

const MODULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["what", "responsibilities", "keyFiles", "dataIn", "dataOut", "extendHere", "risks"],
  properties: {
    what: { type: "string" },
    responsibilities: { type: "array", items: { type: "string" } },
    keyFiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "why"],
        properties: { path: { type: "string" }, why: { type: "string" } },
      },
    },
    dataIn: { type: "array", items: { type: "string" } },
    dataOut: { type: "array", items: { type: "string" } },
    extendHere: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
};

async function buildModuleBriefs(cfg, repoId, onProgress) {
  const modules = db
    .prepare(
      `SELECT module, COUNT(*) AS files
       FROM files WHERE repo_id = ? AND deleted = 0 AND module IS NOT NULL AND module != ''
       GROUP BY module ORDER BY files DESC
       LIMIT ?`,
    )
    .all(repoId, config.limits.kgMaxModules);
  if (modules.length === 0) return [];

  const results = await providers.pool(
    modules,
    config.limits.maxConcurrency,
    async (m) => {
      const files = db
        .prepare(
          `SELECT path, layer, role, summary, heat, churn, degree
           FROM files WHERE repo_id = ? AND module = ? AND deleted = 0
           ORDER BY degree DESC, heat DESC LIMIT 60`,
        )
        .all(repoId, m.module);

      const links = db
        .prepare(
          `SELECT DISTINCT f2.module AS other, e.kind AS kind
           FROM edges e
           JOIN files f1 ON f1.id = e.src_id
           JOIN files f2 ON f2.id = e.dst_id
           WHERE e.repo_id = ? AND f1.module = ? AND f2.module IS NOT NULL AND f2.module != f1.module
           LIMIT 40`,
        )
        .all(repoId, m.module);

      const brief = await providers.askJson(cfg, {
        system: `Write the brief for one feature module of a codebase, for an agent about to work inside it.

- what: what this module is responsible for, 1-2 sentences.
- responsibilities: the concrete jobs it owns. 3-6 items.
- keyFiles: the files someone must read first, and why each matters. 3-8 items, paths taken
  verbatim from the list given.
- dataIn: what enters this module (events, requests, queue messages, props).
- dataOut: what it produces (responses, records written, events emitted).
- extendHere: where to add a new capability of this kind, as concrete paths or patterns.
- risks: what breaks if this module is changed carelessly.

Ground everything in the files listed. Do not describe files you were not shown.`,
        user: `Module "${m.module}" (${m.files} files)

Files:
${files.map((f) => `- ${f.path} [${f.layer}] ${f.role || ""} — ${f.summary || ""}`).join("\n")}

Connects to other modules: ${links.map((l) => `${l.other} (${l.kind})`).join(", ") || "(none)"}`,
        schema: MODULE_SCHEMA,
        effort: "medium",
      });

      return { module: m.module, fileCount: m.files, ...brief };
    },
    onProgress,
  );

  return results.filter((r) => r && !r.error);
}

// ── 6. what changed ──────────────────────────────────────────────────────────

const CHANGELOG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "changes", "affectedModules", "agentImpact"],
  properties: {
    headline: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["what", "where", "why", "breaking"],
        properties: {
          what: { type: "string" },
          where: { type: "string" },
          why: { type: "string" },
          breaking: { type: "boolean" },
        },
      },
    },
    affectedModules: { type: "array", items: { type: "string" } },
    agentImpact: { type: "array", items: { type: "string" } },
  },
};

/**
 * "What changed" written for an agent that already holds the previous graph:
 * which of its assumptions just became wrong.
 */
async function buildChangelog(cfg, repoId, commits, diffstat) {
  if (commits.length === 0) return null;

  const touched = db
    .prepare(
      `SELECT DISTINCT f.path, f.module, f.layer, f.role
       FROM file_changes fc
       JOIN commits c ON c.id = fc.commit_id
       JOIN files f ON f.repo_id = fc.repo_id AND f.path = fc.path
       WHERE fc.repo_id = ? AND c.sha IN (${commits.map(() => "?").join(",") || "''"})
       LIMIT 200`,
    )
    .all(repoId, ...commits.map((c) => c.sha));

  return providers
    .askJson(cfg, {
      system: `Summarise what changed in this repository for an agent that already knows the old codebase.
Say what is now different, not what the commits were called.

- headline: one line covering the whole batch.
- changes: each meaningful change — what changed, where (paths or module), why, and whether it
  breaks existing callers.
- affectedModules: module names touched.
- agentImpact: what an agent that memorised the previous version must now unlearn — changed payloads,
  renamed endpoints, moved files, new required config. Empty array if nothing behavioural changed.`,
      user: `Merges:
${commits.map((c) => `- ${String(c.date).slice(0, 10)} ${c.shortSha} ${c.subject} (${c.author})`).join("\n")}

Files touched:
${touched.map((f) => `- ${f.path} [${f.layer}] ${f.module || "?"} — ${f.role || ""}`).join("\n")}

Diffstat:
${String(diffstat || "").slice(0, 6000)}`,
      schema: CHANGELOG_SCHEMA,
      effort: "medium",
    })
    .catch(() => null);
}

// ── persistence ──────────────────────────────────────────────────────────────

/** Drop module briefs and playbooks for modules the current taxonomy dropped. */
function pruneStaleModuleDocs(repoId) {
  const live = new Set(
    db
      .prepare(
        `SELECT DISTINCT module FROM files
         WHERE repo_id = ? AND deleted = 0 AND module IS NOT NULL AND module != ''`,
      )
      .all(repoId)
      .map((r) => r.module),
  );
  if (live.size === 0) return 0;

  const stale = db
    .prepare(`SELECT id, key FROM kg_docs WHERE repo_id = ? AND kind IN ('module', 'playbook')`)
    .all(repoId)
    .filter((row) => !live.has(row.key));

  if (stale.length === 0) return 0;
  const remove = db.prepare(`DELETE FROM kg_docs WHERE id = ?`);
  db.transaction(() => {
    for (const row of stale) remove.run(row.id);
  })();
  return stale.length;
}

function putDoc(repoId, kind, key, title, body) {
  db.prepare(
    `INSERT INTO kg_docs (repo_id, kind, key, title, body, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(repo_id, kind, key) DO UPDATE SET
       title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
  ).run(repoId, kind, key, title, JSON.stringify(body));
}

/**
 * Refuse to replace a populated table with nothing.
 *
 * These passes are many model calls, and every one of them can fail. Clearing
 * the table first meant a bad afternoon on the API turned "we know 40 endpoints"
 * into "this repository has no endpoints" — stated with total confidence in the
 * exported document. An empty result is now treated as "learned nothing this
 * run", not as "there is nothing".
 */
/**
 * Remove the rows a scoped pass is about to replace.
 *
 * A full run clears the table: everything is being re-derived. A scoped run has
 * only looked at the files that changed, so clearing the table would delete the
 * knowledge for every file it did not read — the exported graph would shrink a
 * little more with each scheduled sync until only the last change remained.
 */
function clearScope(repoId, table, column, scope) {
  if (!scope) {
    db.prepare(`DELETE FROM ${table} WHERE repo_id = ?`).run(repoId);
    return;
  }
  if (scope.size === 0) return;
  const del = db.prepare(`DELETE FROM ${table} WHERE repo_id = ? AND ${column} = ?`);
  for (const p of scope) del.run(repoId, p);
}

function wouldEraseKnowledge(repoId, table, incoming) {
  if (incoming.length > 0) return false;
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id = ?`).get(repoId).n;
  if (existing === 0) return false;
  progress("kg", `Keeping ${existing} known ${table}: this run extracted none`);
  return true;
}

function saveEndpoints(repoId, endpoints, scope) {
  if (!scope && wouldEraseKnowledge(repoId, "endpoints", endpoints)) return;
  // Some batches failed, so this result is incomplete by construction. Upsert
  // what came back and delete nothing.
  if (endpoints.failedBatches > 0) scope = new Set();
  const insert = db.prepare(
    `INSERT INTO endpoints
       (repo_id, method, path, handler_path, handler_symbol, module, auth, middleware,
        request_shape, response_shape, status_codes, summary, evidence)
     VALUES (@repo_id, @method, @path, @handler_path, @handler_symbol, @module, @auth, @middleware,
             @request_shape, @response_shape, @status_codes, @summary, @evidence)
     ON CONFLICT(repo_id, method, path) DO UPDATE SET
       handler_path = excluded.handler_path, handler_symbol = excluded.handler_symbol,
       module = excluded.module, auth = excluded.auth, middleware = excluded.middleware,
       request_shape = excluded.request_shape, response_shape = excluded.response_shape,
       status_codes = excluded.status_codes, summary = excluded.summary, evidence = excluded.evidence`,
  );
  const moduleOf = db.prepare(`SELECT module FROM files WHERE repo_id = ? AND path = ?`);

  db.transaction(() => {
    clearScope(repoId, "endpoints", "handler_path", scope);
    for (const e of endpoints) {
      if (!e.method || !e.path) continue;
      const owner = e.handlerPath ? moduleOf.get(repoId, e.handlerPath) : null;
      insert.run({
        repo_id: repoId,
        method: String(e.method).toUpperCase(),
        path: e.path,
        handler_path: e.handlerPath || null,
        handler_symbol: e.handlerSymbol || null,
        module: (owner && owner.module) || null,
        auth: e.auth || null,
        middleware: JSON.stringify(e.middleware || []),
        request_shape: JSON.stringify({
          pathParams: e.pathParams || [],
          queryParams: e.queryParams || [],
          bodyFields: e.bodyFields || [],
        }),
        response_shape: JSON.stringify({
          success: e.responseSuccess || "",
          errors: e.responseErrors || [],
        }),
        status_codes: JSON.stringify(e.statusCodes || []),
        summary: e.summary || null,
        evidence: e.evidence ? String(e.evidence).slice(0, 400) : null,
      });
    }
  })();
}

function saveEntities(repoId, entities, scope) {
  if (!scope && wouldEraseKnowledge(repoId, "entities", entities)) return;
  // Some batches failed, so this result is incomplete by construction. Upsert
  // what came back and delete nothing.
  if (entities.failedBatches > 0) scope = new Set();
  const insert = db.prepare(
    `INSERT INTO entities (repo_id, name, file_path, store, fields, relations, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, name) DO UPDATE SET
       file_path = excluded.file_path, store = excluded.store, fields = excluded.fields,
       relations = excluded.relations, summary = excluded.summary`,
  );
  db.transaction(() => {
    clearScope(repoId, "entities", "file_path", scope);
    for (const e of entities) {
      if (!e.name) continue;
      insert.run(
        repoId,
        e.name,
        e.filePath || null,
        e.store || null,
        JSON.stringify(e.fields || []),
        JSON.stringify(e.relations || []),
        e.summary || null,
      );
    }
  })();
}

function saveScreens(repoId, screens, scope) {
  if (!scope && wouldEraseKnowledge(repoId, "screens", screens)) return;
  // Some batches failed, so this result is incomplete by construction. Upsert
  // what came back and delete nothing.
  if (screens.failedBatches > 0) scope = new Set();
  const insert = db.prepare(
    `INSERT INTO screens (repo_id, name, route, file_path, components, calls, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, name) DO UPDATE SET
       route = excluded.route, file_path = excluded.file_path, components = excluded.components,
       calls = excluded.calls, summary = excluded.summary`,
  );
  db.transaction(() => {
    clearScope(repoId, "screens", "file_path", scope);
    for (const s of screens) {
      if (!s.name) continue;
      insert.run(
        repoId,
        s.name,
        s.route || null,
        s.filePath || null,
        JSON.stringify(s.components || []),
        JSON.stringify(s.calls || []),
        s.summary || null,
      );
    }
  })();
}

/**
 * Environment variables come from the static scan, not the model: a missing var
 * breaks a deploy, so this list has to be exhaustive rather than plausible.
 */
function saveEnvVars(repoId, scanned, manifests) {
  const usedIn = new Map();
  for (const f of scanned) {
    for (const name of f.envVars) {
      if (!usedIn.has(name)) usedIn.set(name, []);
      const list = usedIn.get(name);
      if (list.length < 12) list.push(f.path);
    }
  }

  // A name in .env.example is declared, so treat it as required and keep its sample value.
  const examples = new Map();
  const exampleBody = (manifests.envExample || manifests.envSample || {}).body || "";
  for (const line of exampleBody.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) examples.set(m[1], m[2].trim());
  }

  const insert = db.prepare(
    `INSERT INTO env_vars (repo_id, name, required, example, used_in, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, name) DO UPDATE SET
       required = excluded.required, example = excluded.example, used_in = excluded.used_in`,
  );

  db.transaction(() => {
    db.prepare(`DELETE FROM env_vars WHERE repo_id = ?`).run(repoId);
    for (const name of new Set([...usedIn.keys(), ...examples.keys()])) {
      insert.run(
        repoId,
        name,
        examples.has(name) ? 1 : 0,
        examples.get(name) || null,
        JSON.stringify(usedIn.get(name) || []),
        usedIn.has(name) ? null : "declared in .env.example but no read found in source",
      );
    }
  })();
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Build (or refresh) the whole knowledge graph for a repo.
 *
 * `ctx` carries the artefacts the index pass already produced — the scan, the
 * resolved imports, the agreed taxonomy — so nothing is recomputed here.
 */
/** null on a full run (replace everything), the processed paths on a scoped one. */
function scopeFor(ctx, pass) {
  if (ctx.full || !ctx.changedPaths) return null;
  return (ctx.processedBy && ctx.processedBy[pass]) || new Set();
}

async function buildKnowledgeGraph(repoId, ctx, opts = {}) {
  const cfg = ctx.provider;
  const repo = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);

  const layerCounts = Object.fromEntries(
    db
      .prepare(
        `SELECT layer, COUNT(*) AS n FROM files WHERE repo_id = ? AND deleted = 0 GROUP BY layer`,
      )
      .all(repoId)
      .map((r) => [r.layer, r.n]),
  );
  const hotFiles = db
    .prepare(
      `SELECT path, role, churn FROM files WHERE repo_id = ? AND deleted = 0 ORDER BY heat DESC LIMIT 15`,
    )
    .all(repoId);
  const topDirs = [...new Set(ctx.scanned.map((f) => f.path.split("/")[0]))].slice(0, 25);
  const layerOf = new Map(
    db
      .prepare(`SELECT path, layer FROM files WHERE repo_id = ? AND deleted = 0`)
      .all(repoId)
      .map((r) => [r.path, r.layer]),
  );

  const passCtx = { ...ctx, repo, layerCounts, hotFiles, topDirs, layerOf };
  ctx.dir = ctx.dir || require("../git").workdirFor(repoId, repo.url);

  progress("kg", "Writing the repository overview");
  const overview = await buildOverview(cfg, passCtx).catch((err) => ({ error: err.message }));
  if (!overview.error) putDoc(repoId, "overview", "main", `${repo.name} — overview`, overview);

  progress("kg", "Extracting the API surface");
  const endpoints = await buildEndpoints(cfg, passCtx, (done, total) =>
    progress("kg", `API surface: ${done}/${total} batches`),
  );
  saveEndpoints(repoId, endpoints, scopeFor(passCtx, "endpoints"));

  progress("kg", "Extracting data models");
  const entities = await buildEntities(cfg, passCtx, (done, total) =>
    progress("kg", `Data models: ${done}/${total} batches`),
  );
  saveEntities(repoId, entities, scopeFor(passCtx, "entities"));

  progress("kg", "Mapping screens to endpoints");
  const screens = await buildScreens(cfg, passCtx, (done, total) =>
    progress("kg", `Screens: ${done}/${total} batches`),
  );
  saveScreens(repoId, screens, scopeFor(passCtx, "screens"));

  progress("kg", "Reading environment configuration");
  saveEnvVars(repoId, ctx.scanned, ctx.manifests);

  progress("kg", "Writing module briefs");
  const briefs = await buildModuleBriefs(cfg, repoId, (done, total) =>
    progress("kg", `Module briefs: ${done}/${total}`),
  );
  for (const b of briefs) putDoc(repoId, "module", b.module, `Module: ${b.module}`, b);

  // The feature taxonomy is re-derived on every full index, so a module can stop
  // existing. Its brief and its playbook have to go with it — otherwise the
  // export ships documentation for modules the code no longer has, which is
  // worse than shipping none.
  pruneStaleModuleDocs(repoId);

  // ── the depth an agent needs ────────────────────────────────────────────────
  // Architecture tells an agent where it is. Contracts, error meanings and
  // playbooks are what let it change something without breaking it.
  if (opts.deep !== false) {
    progress("kg", "Writing function contracts");
    await enrichSymbols(cfg, repoId, ctx.dir, { limit: opts.symbolLimit ?? 120 }).catch((err) =>
      progress("kg", `Function contracts skipped: ${err.message}`),
    );

    progress("kg", "Explaining errors");
    await explainErrors(cfg, repoId).catch((err) =>
      progress("kg", `Error meanings skipped: ${err.message}`),
    );

    progress("kg", "Writing debugging playbooks");
    await buildPlaybooks(cfg, repoId).catch((err) =>
      progress("kg", `Playbooks skipped: ${err.message}`),
    );
  }

  if (opts.commits && opts.commits.length > 0) {
    progress("kg", "Recording what changed");
    const changelog = await buildChangelog(cfg, repoId, opts.commits, opts.diffstat);
    if (changelog) {
      const key = new Date().toISOString().replace(/[:.]/g, "-");
      putDoc(repoId, "changelog", key, changelog.headline || "Changes", {
        ...changelog,
        sinceSha: opts.sinceSha || null,
        toSha: opts.toSha || null,
        commits: opts.commits.map((c) => ({ sha: c.shortSha, subject: c.subject, date: c.date })),
      });
    }
  }

  db.prepare(`UPDATE repos SET kg_built_at = datetime('now') WHERE id = ?`).run(repoId);

  return {
    overview: overview.error ? null : overview,
    endpoints: endpoints.length,
    entities: entities.length,
    screens: screens.length,
    modules: briefs.length,
    playbooks: db
      .prepare(`SELECT COUNT(*) AS n FROM kg_docs WHERE repo_id = ? AND kind = 'playbook'`)
      .get(repoId).n,
    describedFunctions: db
      .prepare(`SELECT COUNT(*) AS n FROM symbols WHERE repo_id = ? AND purpose IS NOT NULL`)
      .get(repoId).n,
  };
}

/** The whole graph, assembled for export or for the UI. */
function readKnowledgeGraph(repoId) {
  const repo = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);

  const doc = (kind, key) => {
    const row = db
      .prepare(`SELECT * FROM kg_docs WHERE repo_id = ? AND kind = ? AND key = ?`)
      .get(repoId, kind, key);
    return row ? parseJson(row.body, null) : null;
  };

  const docs = (kind) =>
    db
      .prepare(`SELECT key, title, body, updated_at FROM kg_docs WHERE repo_id = ? AND kind = ? ORDER BY key`)
      .all(repoId, kind)
      .map((r) => ({ key: r.key, title: r.title, updatedAt: r.updated_at, ...parseJson(r.body, {}) }));

  return {
    repo: {
      name: repo.name,
      url: repo.url,
      branch: repo.default_branch,
      indexedSha: repo.last_indexed_sha,
      indexedAt: repo.last_indexed_at,
      builtAt: repo.kg_built_at,
    },
    overview: doc("overview", "main"),
    modules: docs("module"),
    changelog: docs("changelog").sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 20),
    endpoints: db
      .prepare(`SELECT * FROM endpoints WHERE repo_id = ? ORDER BY path, method`)
      .all(repoId)
      .map((e) => ({
        method: e.method,
        path: e.path,
        handler: e.handler_path,
        symbol: e.handler_symbol,
        module: e.module,
        auth: e.auth,
        middleware: parseJson(e.middleware, []),
        request: parseJson(e.request_shape, {}),
        response: parseJson(e.response_shape, {}),
        statusCodes: parseJson(e.status_codes, []),
        summary: e.summary,
        evidence: e.evidence,
      })),
    entities: db
      .prepare(`SELECT * FROM entities WHERE repo_id = ? ORDER BY name`)
      .all(repoId)
      .map((e) => ({
        name: e.name,
        filePath: e.file_path,
        store: e.store,
        fields: parseJson(e.fields, []),
        relations: parseJson(e.relations, []),
        summary: e.summary,
      })),
    screens: db
      .prepare(`SELECT * FROM screens WHERE repo_id = ? ORDER BY name`)
      .all(repoId)
      .map((s) => ({
        name: s.name,
        route: s.route,
        filePath: s.file_path,
        components: parseJson(s.components, []),
        calls: parseJson(s.calls, []),
        summary: s.summary,
      })),
    env: db
      .prepare(`SELECT * FROM env_vars WHERE repo_id = ? ORDER BY name`)
      .all(repoId)
      .map((v) => ({
        name: v.name,
        required: Boolean(v.required),
        example: v.example,
        usedIn: parseJson(v.used_in, []),
        note: v.note,
      })),
    // Same column set the graph's hotspot list returns, aliases included: two
    // shapes for "a hot file" is one shape too many, and the client decodes both
    // with the same type.
    hotspots: db
      .prepare(
        `SELECT path, layer, module, role, summary, loc, heat, churn,
                commit_count AS merges, degree, last_change_at
         FROM files WHERE repo_id = ? AND deleted = 0 ORDER BY heat DESC LIMIT 40`,
      )
      .all(repoId),

    // ── the agent-facing depth ────────────────────────────────────────────────
    playbooks: docs("playbook"),

    /** Every request path, proven from the call graph rather than inferred. */
    flows: listFlows(repoId),

    /** Paste a log line in, find where it came from and what to check. */
    errors: listErrors(repoId),

    /** Which tests cover which file, and what they assert. */
    tests: listTestMap(repoId),

    /** Function contracts: purpose, returns, side effects, what it throws. */
    functions: db
      .prepare(
        `SELECT path, name, kind, line, signature, params, exported, layer, module,
                purpose, returns, side_effects, throws, in_degree, out_degree
         FROM symbols
         WHERE repo_id = ? AND deleted = 0 AND (purpose IS NOT NULL OR exported = 1)
         ORDER BY (in_degree + out_degree) DESC LIMIT 400`,
      )
      .all(repoId)
      .map((s) => ({
        path: s.path,
        name: s.name,
        kind: s.kind,
        line: s.line,
        location: `${s.path}:${s.line}`,
        signature: s.signature,
        params: s.params,
        exported: Boolean(s.exported),
        layer: s.layer,
        module: s.module,
        purpose: s.purpose,
        returns: s.returns,
        sideEffects: parseJson(s.side_effects, []),
        throws: parseJson(s.throws, []),
        calledBy: s.in_degree,
        calls: s.out_degree,
      })),
  };
}

module.exports = { buildKnowledgeGraph, readKnowledgeGraph, pruneStaleModuleDocs };
