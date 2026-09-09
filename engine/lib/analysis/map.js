"use strict";

// The architecture pass: what is each file, which feature does it belong to,
// and which relationships exist that a static import scan cannot see.
//
// Two rules run through everything here. Import edges are already known
// statically, so the model is shown them and told not to repeat them. And every
// inferred edge must quote a real line from the source file — the caller checks
// that quote against the file on disk and drops the edge if it does not match.

const { config } = require("../config");
const providers = require("../providers");
const { LAYERS } = require("./scan");

const SYSTEM = `You are a senior software architect mapping a repository into an architecture graph.

Layer definitions — pick the single best fit:
- route: declares URL/RPC endpoints and binds them to handlers.
- controller: request handlers / API endpoint bodies that orchestrate a request.
- middleware: cross-cutting request pipeline code (auth, logging, CORS, guards, interceptors, policies). NOT ordinary API client wrappers.
- service: reusable application logic, API clients, integrations, repositories, helpers.
- engine: core domain logic / algorithms / state machines the app is built around.
- model: data schemas, entities, ORM models, migrations.
- page: user-facing screens, views, templates.
- component: reusable UI pieces.
- job: background workers, queues, cron tasks, CLI commands.
- config: configuration and environment wiring.
- test: tests and fixtures.
- infra: build, deploy, CI, container, IaC.
- other: only when nothing above fits.

For every file return:
- layer: one of ${LAYERS.join(", ")}
- role: 3-6 word description of the file's job ("handles checkout webhooks")
- module: the feature/domain bucket, short lowercase ("billing", "auth", "search").
- summary: one sentence, max 20 words.

EDGES — accuracy matters more than coverage.
You are given each file's already-resolved imports, so import edges are ALREADY KNOWN: do not repeat them.
Report only relationships a static import scan cannot see, for example:
- a route file binding a URL to a specific controller function
- a controller applying a named middleware
- a job invoking an engine or service by name
- a page rendering a component resolved at runtime

Rules, applied strictly:
1. "from" and "to" MUST be exact paths from the provided list. Never invent a path.
2. "evidence" MUST be a VERBATIM substring copied from the FROM file's source shown to you —
   the actual line that proves the relationship. Not a paraphrase, not a description.
3. If you cannot copy a proving line out of the source, DO NOT emit the edge.
4. An edge you are unsure about is worse than no edge. Emit nothing rather than guessing.`;

const MAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["files", "edges"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "layer", "role", "module", "summary"],
        properties: {
          path: { type: "string" },
          layer: { type: "string", enum: LAYERS },
          role: { type: "string" },
          module: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "kind", "evidence"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          kind: {
            type: "string",
            enum: ["route->controller", "uses-middleware", "calls", "renders", "related"],
          },
          evidence: { type: "string" },
        },
      },
    },
  },
};

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapBatch(cfg, files, repoContext, resolvedImports) {
  const payload = files.map((f) => ({
    path: f.path,
    loc: f.loc,
    hints: f.hints,
    exports: f.exports,
    // Showing the resolved imports stops the model re-deriving what we already
    // know and focuses it on the runtime wiring we cannot see.
    resolvedImports: resolvedImports.get(f.path) || [],
    routeWiring: f.routeLines,
    outboundCalls: f.callLines,
    source: f.head,
  }));

  const parsed = await providers.askJson(cfg, {
    system: SYSTEM,
    user: `Repository context:\n${repoContext}\n\nFiles (JSON):\n${JSON.stringify(payload)}`,
    schema: MAP_SCHEMA,
  });

  return { files: parsed.files || [], edges: parsed.edges || [] };
}

/** Maps every file through the model, batched and concurrency-limited. */
async function mapRepository(cfg, files, repoContext, resolvedImports, onProgress) {
  const batches = chunk(files, config.limits.mapBatchSize);
  const merged = { files: [], edges: [] };
  let mapped = 0;

  const results = await providers.pool(
    batches,
    config.limits.maxConcurrency,
    (batch) => mapBatch(cfg, batch, repoContext, resolvedImports),
    (done) => {
      mapped = Math.min(files.length, done * config.limits.mapBatchSize);
      if (onProgress) onProgress(mapped, files.length);
    },
  );

  for (const r of results) {
    if (!r || r.error) continue;
    merged.files.push(...r.files);
    merged.edges.push(...r.edges);
  }
  return merged;
}

// ── feature taxonomy ─────────────────────────────────────────────────────────

const TAXONOMY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["modules"],
  properties: {
    modules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description"],
        properties: { name: { type: "string" }, description: { type: "string" } },
      },
    },
  },
};

function assignmentSchema(names) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["assignments"],
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "module"],
          properties: {
            path: { type: "string" },
            // The enum forces every answer onto the agreed vocabulary instead of
            // letting each batch invent its own.
            module: { type: "string", enum: names },
          },
        },
      },
    },
  };
}

const BANNED_MODULES = ["shared", "core", "common", "misc", "other", "utils"];

/** Step 1: agree on a module vocabulary for the whole repo before assigning anything. */
async function proposeTaxonomy(cfg, files) {
  const dirCounts = new Map();
  for (const f of files) {
    const dir = f.path.split("/").slice(0, 2).join("/");
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
  }
  const dirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80);
  const sample = files
    .filter((f) => f.role)
    .slice(0, 160)
    .map((f) => `${f.path} — ${f.role}`);

  const parsed = await providers.askJson(cfg, {
    system: `Propose a module taxonomy for a codebase: the product capabilities it is built from
("billing", "tax-forms", "bank-feeds", "reconciliation", "auth", "reporting"), NOT technical layers
and NOT generic buckets. Rules:
- 10 to 20 modules. Short lowercase names, hyphenated if needed.
- Derive them from the domain nouns in the paths and roles you are shown.
- Include at most one catch-all ("platform") and expect it to stay small.
- Never propose "shared", "core", "common", "misc", "other", "utils" as a module name.`,
    user: `Directory counts:\n${dirs.map(([d, n]) => `${d} (${n})`).join("\n")}\n\nSample files:\n${sample.join("\n")}`,
    schema: TAXONOMY_SCHEMA,
    effort: "medium",
  });

  return (parsed.modules || [])
    .map((m) => ({
      name: String(m.name || "").trim().toLowerCase().replace(/\s+/g, "-"),
      description: m.description,
    }))
    .filter((m) => m.name && !BANNED_MODULES.includes(m.name))
    .slice(0, 20);
}

/**
 * Step 2: assign every file to that agreed vocabulary. Per-file batches would
 * otherwise each invent their own names and everything lands in one "shared" bucket.
 */
async function assignModules(cfg, files) {
  const out = new Map();
  if (files.length === 0) return { assignments: out, taxonomy: [] };

  const fast = providers.fastVariant(cfg);
  const taxonomy = await proposeTaxonomy(fast, files).catch(() => []);
  if (taxonomy.length === 0) return { assignments: out, taxonomy: [] };

  const names = [...taxonomy.map((t) => t.name), "platform"];
  const schema = assignmentSchema(names);
  const menu = taxonomy.map((t) => `- ${t.name}: ${t.description}`).join("\n");

  const results = await providers.pool(chunk(files, 60), config.limits.maxConcurrency, (batch) =>
    providers.askJson(fast, {
      system: `Assign each file to exactly one module from this fixed list:\n${menu}\n- platform: only for genuinely cross-cutting infrastructure with no feature owner.
Pick the module whose capability the file serves. Use the path and role as evidence.
Keep "platform" rare — under one file in ten.`,
      user: JSON.stringify(batch.map((f) => ({ path: f.path, role: f.role, layer: f.layer }))),
      schema,
      effort: "low",
    }),
  );

  for (const r of results) {
    if (!r || r.error) continue;
    for (const a of r.assignments || []) if (a.module) out.set(a.path, a.module);
  }
  return { assignments: out, taxonomy };
}

/** Short natural-language digest of where effort is landing, shown on the dashboard. */
async function summarizeActivity(cfg, repoName, hotFiles, commits) {
  if (hotFiles.length === 0) return "";
  return providers
    .askText(cfg, {
      system:
        "Summarize where engineering effort is concentrating in a repo. 3 sentences max, concrete, no preamble.",
      user: `Repo: ${repoName}\nHottest files:\n${hotFiles
        .map((f) => `- ${f.path} (${f.role || "unknown role"}), churn ${f.churn}`)
        .join("\n")}\n\nRecent merges:\n${commits
        .map((c) => `- ${String(c.date).slice(0, 10)} ${c.subject}`)
        .join("\n")}`,
      effort: "low",
    })
    .catch(() => "");
}

module.exports = { mapRepository, assignModules, summarizeActivity, chunk };
