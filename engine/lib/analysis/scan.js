"use strict";

// Static pass over the working tree. Everything here is cheap, deterministic
// and evidence-based — the model never sees a file we did not read, and the
// facts extracted here are what keep its answers honest later.

const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../config");
const { readJson } = require("./resolve");
const {
  extractSymbols,
  extractCallSites,
  extractRenderedComponents,
  extractRouteHandlers,
  moduleScopeSymbol,
} = require("./symbols");

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".php", ".py", ".rb", ".go", ".java", ".kt", ".cs", ".rs", ".ex", ".exs",
  ".scala", ".swift", ".dart",
]);

const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "out", "target", ".next",
  ".nuxt", "coverage", "__pycache__", ".venv", "venv", "bower_components",
  ".idea", ".vscode", "storage", ".turbo", ".svelte-kit", "Pods", "DerivedData",
]);

const IMPORT_PATTERNS = [
  /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,          // ES import
  /import\s+['"]([^'"]+)['"]/g,                        // bare ES import
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,                // CJS
  /from\s+([\w.]+)\s+import\s+/g,                      // python
  /^\s*import\s+([\w.]+)/gm,                           // python/java/go
  /use\s+([A-Za-z0-9_\\]+);/g,                         // php use
  /require(?:_relative|_once)?\s+['"]([^'"]+)['"]/g,   // ruby/php
  /@?include\s+['"]([^'"]+)['"]/g,                     // blade/erb-ish
];

const EXPORT_PATTERNS = [
  /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /exports\.([A-Za-z_$][\w$]*)\s*=/g,
  /module\.exports\s*=\s*\{([^}]*)\}/g,
  /(?:^|\n)\s*(?:public|protected)?\s*(?:static\s+)?function\s+([A-Za-z_][\w]*)\s*\(/g,
  /(?:^|\n)\s*def\s+([a-z_][\w]*)\s*\(/g,
  /(?:^|\n)\s*class\s+([A-Za-z_][\w]*)/g,
];

/** Lines that wire URLs to handlers — the best evidence for route → controller edges. */
const ROUTE_LINE =
  /(?:Route::|router\.|app\.|api\.)(?:get|post|put|patch|delete|use|all|options|head)\s*\(.{0,240}|@(?:Get|Post|Put|Patch|Delete|Request)Mapping\s*\(.{0,160}|@app\.route\s*\(.{0,160}|@(?:router|app)\.(?:get|post|put|patch|delete)\s*\(.{0,160}|(?:get|post|put|patch|delete)\s+['"]\/[^'"]*['"]\s*(?:=>|,|do)/g;

/** Places the code CALLS an HTTP API — the other half of the request/response map. */
const CALL_LINE =
  /(?:fetch|axios(?:\.\w+)?|http(?:Client)?\.(?:get|post|put|patch|delete)|\$\.(?:get|post|ajax)|requests\.(?:get|post|put|patch|delete)|HttpClient|URLSession)\s*(?:\(|\.)[^\n]{0,200}/g;

/** Environment variables the code reads. Second half of "how do I run this". */
const ENV_PATTERNS = [
  /process\.env\.([A-Z0-9_]+)/g,
  /process\.env\[['"]([A-Z0-9_]+)['"]\]/g,
  /import\.meta\.env\.([A-Z0-9_]+)/g,
  /os\.environ(?:\.get)?[.[(]\s*['"]([A-Z0-9_]+)['"]/g,
  /getenv\(\s*['"]([A-Z0-9_]+)['"]/g,
  /ENV\[['"]([A-Z0-9_]+)['"]\]/g,
  /env\(\s*['"]([A-Za-z0-9_]+)['"]/g,
  /config\(\s*['"]([A-Za-z0-9_.]+)['"]/g,
];

const HINT_PATTERNS = [
  [/Route::|router\.(get|post|put|patch|delete|use)\b|app\.(get|post|put|use)\b|@(Get|Post|Put|Delete)Mapping|@app\.route|Rails\.application\.routes|createBrowserRouter|<Route\s/i, "declares-routes"],
  [/extends\s+\w*Controller|class\s+\w*Controller\b|@Controller\b|def\s+\w+\(self,\s*request/i, "controller-class"],
  [/\bmiddleware\s*[:(=]|use\((?:[^)]*)(?:auth|cors|helmet|guard)|handle\s*\(\s*\$request\s*,\s*Closure|next\s*\)\s*=>|\(req,\s*res,\s*next\)/i, "middleware"],
  [/extends\s+Model\b|@Entity\b|Schema\s*\(|mongoose\.model|sequelize\.define|class\s+\w+\(Base\)|prisma\.|@Table\b/i, "data-model"],
  [/export\s+default\s+function\s+\w*Page|getServerSideProps|getStaticProps|<template>|export\s+default\s+\{[\s\S]*components/i, "page-or-view"],
  [/useState|useEffect|export\s+(default\s+)?function\s+[A-Z]\w*\s*\(/, "ui-component"],
  [/class\s+\w*(Service|Manager|Engine|Processor|Handler|Repository)\b|def\s+\w*engine/i, "service-or-engine"],
  [/cron|schedule|queue|Job\b|Worker\b|celery|sidekiq|bull|@Scheduled/i, "background-job"],
  // Word boundaries and a negative lookbehind matter here: without them `.test(`
  // in a regex call and `edit(` in ordinary code both read as "this is a test file".
  [/(?<![.\w])describe\(|(?<![.\w])it\(|(?<![.\w])test\(|\bdef test_|@Test\b|(?<![.\w])expect\(/, "test"],
  [/zod|joi\.|yup\.|class-validator|pydantic|BaseModel|@IsString|Schema\.validate/i, "validates-input"],
];

/**
 * The heuristic layer, used before the model has seen a file and as the fallback
 * for anything the model skips.
 *
 * Explicit path signals are checked before content hints, because a file living
 * in `config/` is configuration even if it happens to mention a cron expression,
 * and `services/llm.ts` is a service even though it contains the word middleware.
 */
const PATH_RULES = [
  [/(^|\/)(tests?|spec|__tests__|e2e)\/|\.(test|spec)\./, "test"],
  [/(^|\/)routes?(\/|\.)|(^|\/)api\//, "route"],
  [/controller/, "controller"],
  [/(^|\/)(middlewares?|guards?|interceptors?|policies)(\/|\.)/, "middleware"],
  [/(^|\/)(models?|entities|schemas?)\//, "model"],
  [/(^|\/)(pages?|views?|screens?|templates?)\//, "page"],
  [/(^|\/)components?\//, "component"],
  [/(^|\/)(jobs?|workers?|tasks?|commands?|console)\//, "job"],
  [/(^|\/)(services?|usecases?|repositories|helpers?|utils?)\//, "service"],
  [/(^|\/)config\/|\.(env|ya?ml|toml|ini)$|(^|\/)config\.[a-z]+$/, "config"],
  [/dockerfile|\.tf$|k8s|deploy|\.github\//, "infra"],
  [/(^|\/)(core|domain|engines?)\//, "engine"],
];

const HINT_LAYER = [
  ["test", "test"],
  ["declares-routes", "route"],
  ["controller-class", "controller"],
  ["middleware", "middleware"],
  ["data-model", "model"],
  ["page-or-view", "page"],
  ["ui-component", "component"],
  ["background-job", "job"],
  ["service-or-engine", "service"],
];

function guessLayer(p, hints) {
  const l = p.toLowerCase();
  for (const [re, layer] of PATH_RULES) if (re.test(l)) return layer;
  for (const [hint, layer] of HINT_LAYER) if (hints.includes(hint)) return layer;
  if (/engine/.test(l)) return "engine";
  if (/(^|\/)lib\//.test(l)) return "service";
  return "other";
}

function walk(root, rel = "", acc = []) {
  if (acc.length >= config.limits.maxFiles) return acc;
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= config.limits.maxFiles) break;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(relPath)) continue;
      walk(root, relPath, acc);
    } else if (e.isFile()) {
      if (!CODE_EXT.has(path.extname(e.name))) continue;
      acc.push(relPath);
    }
  }
  return acc;
}

function matchAll(src, patterns, limit) {
  const out = new Set();
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      for (const name of String(m[1] || "").split(",")) {
        const clean = name.split(":")[0].trim();
        if (clean) out.add(clean);
      }
      if (out.size >= limit) break;
    }
  }
  return [...out].slice(0, limit);
}

function scanRepo(dir) {
  const files = walk(dir);
  const results = [];

  for (const rel of files) {
    const full = path.join(dir, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > config.limits.maxFileBytes) continue;

    let src = "";
    try {
      src = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }

    const imports = matchAll(src, IMPORT_PATTERNS, 120);
    const hints = HINT_PATTERNS.filter(([re]) => re.test(src)).map(([, h]) => h);
    const exports = matchAll(src, EXPORT_PATTERNS, 60).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    const envVars = matchAll(src, ENV_PATTERNS, 40).filter((n) => /^[A-Za-z0-9_.]+$/.test(n));

    ROUTE_LINE.lastIndex = 0;
    const routeLines = [...src.matchAll(ROUTE_LINE)]
      .map((m) => m[0].replace(/\s+/g, " ").trim())
      .slice(0, 60);

    CALL_LINE.lastIndex = 0;
    const callLines = [...src.matchAll(CALL_LINE)]
      .map((m) => m[0].replace(/\s+/g, " ").trim())
      .slice(0, 40);

    results.push({
      path: rel,
      ext: path.extname(rel),
      loc: src.split("\n").length,
      bytes: stat.size,
      imports,
      hints,
      exports,
      envVars,
      routeLines,
      callLines,
      // Function-level facts, all line-anchored, so the graph and the knowledge
      // graph can both point at `path:line` instead of just naming a file.
      // Route handlers come first so that when a named helper and a handler are
      // declared on the same line, the handler is the one that survives. Module
      // scope goes last so it is only ever the fallback owner of a call.
      symbols: [
        ...extractRouteHandlers(src),
        ...extractSymbols(src, rel),
        moduleScopeSymbol(rel),
      ],
      callSites: extractCallSites(src),
      renders: extractRenderedComponents(src),
      // Enough of the file for the model to reason about what it actually does,
      // without shipping whole repositories to the API.
      head: src.slice(0, config.limits.fileContextChars),
    });
  }
  return results;
}

/**
 * Project manifests, read verbatim. These carry the run commands, the framework
 * identity and the declared dependencies — the facts a knowledge graph should
 * quote rather than infer.
 */
function readManifests(dir) {
  const out = {};
  const text = (name, max = 12_000) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8").slice(0, max);
    } catch {
      return null;
    }
  };

  const pkg = readJson(path.join(dir, "package.json"));
  if (pkg) {
    out.node = {
      name: pkg.name,
      version: pkg.version,
      scripts: pkg.scripts || {},
      dependencies: Object.keys(pkg.dependencies || {}),
      devDependencies: Object.keys(pkg.devDependencies || {}),
      packageManager: pkg.packageManager,
      workspaces: pkg.workspaces || null,
      type: pkg.type,
    };
  }

  const composer = readJson(path.join(dir, "composer.json"));
  if (composer) {
    out.php = { name: composer.name, scripts: composer.scripts || {}, require: Object.keys(composer.require || {}) };
  }

  for (const [key, name] of [
    ["compose", "docker-compose.yml"],
    ["compose", "docker-compose.yaml"],
    ["compose", "compose.yml"],
    ["dockerfile", "Dockerfile"],
    ["procfile", "Procfile"],
    ["makefile", "Makefile"],
    ["justfile", "justfile"],
    ["pyproject", "pyproject.toml"],
    ["requirements", "requirements.txt"],
    ["gemfile", "Gemfile"],
    ["gomod", "go.mod"],
    ["cargo", "Cargo.toml"],
    ["envExample", ".env.example"],
    ["envSample", ".env.sample"],
    ["readme", "README.md"],
    ["claudeMd", "CLAUDE.md"],
  ]) {
    if (out[key]) continue;
    const body = text(name, key === "readme" ? 20_000 : 8_000);
    if (body != null) out[key] = { file: name, body };
  }

  // Lock files only matter as an existence signal for the install command.
  out.lockfiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "composer.lock", "poetry.lock", "Gemfile.lock", "Cargo.lock"]
    .filter((f) => fs.existsSync(path.join(dir, f)));

  return out;
}

module.exports = { scanRepo, readManifests, heuristicLayer: guessLayer, LAYERS: [
  "route", "controller", "middleware", "service", "engine", "model",
  "page", "component", "job", "config", "test", "infra", "other",
] };
