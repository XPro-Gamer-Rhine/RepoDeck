"use strict";

/**
 * Import resolution for the dependency graph.
 *
 * Every edge drawn from here is EXTRACTED — it exists literally in the source.
 * The rules mirror what the runtime actually does (Node resolution, tsconfig
 * path aliases, workspace packages, PSR-4 autoload), so an edge is either
 * provably real or it is not drawn at all.
 */

const fs = require("node:fs");
const path = require("node:path");

const EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".php", ".py", ".rb", ".go",
];
const INDEX_NAMES = ["index", "main", "mod", "__init__"];

function readJson(file) {
  try {
    // tsconfig files routinely carry comments and trailing commas.
    const raw = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectTsconfig(root, cfg) {
  for (const name of ["tsconfig.json", "jsconfig.json", "tsconfig.base.json"]) {
    const conf = readJson(path.join(root, name));
    const opts = conf && conf.compilerOptions;
    if (!opts) continue;

    const baseUrl = opts.baseUrl ? path.posix.normalize(String(opts.baseUrl).replace(/^\.\//, "")) : "";
    if (baseUrl && baseUrl !== ".") cfg.roots.push(baseUrl.replace(/\/$/, ""));

    for (const [pattern, targetsRaw] of Object.entries(opts.paths || {})) {
      const targets = (targetsRaw || []).map((t) =>
        path.posix.join(baseUrl && baseUrl !== "." ? baseUrl : "", String(t).replace(/^\.\//, "")),
      );
      cfg.aliases.push({
        prefix: pattern.replace(/\*$/, ""),
        targets: targets.map((t) => t.replace(/\*$/, "")),
        wildcard: pattern.endsWith("*"),
      });
    }
  }
}

function collectPackages(root, cfg) {
  const rootPkg = readJson(path.join(root, "package.json"));
  const patterns = Array.isArray(rootPkg && rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg && rootPkg.workspaces && rootPkg.workspaces.packages) || [];

  const dirs = new Set();
  const scan = (base) => {
    try {
      for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.add(path.posix.join(base, entry.name));
      }
    } catch {
      /* pattern points nowhere — ignore */
    }
  };
  for (const pattern of patterns) scan(String(pattern).replace(/\/\*+$/, ""));
  // Common monorepo layouts, even without a declared workspaces field.
  for (const base of ["packages", "apps", "libs", "services"]) scan(base);

  for (const dir of dirs) {
    const pkg = readJson(path.join(root, dir, "package.json"));
    if (pkg && pkg.name) cfg.packages.set(pkg.name, dir);
  }
}

function collectComposer(root, cfg) {
  const composer = readJson(path.join(root, "composer.json"));
  const psr4 = (composer && composer.autoload && composer.autoload["psr-4"]) || {};
  const psr4Dev = (composer && composer["autoload-dev"] && composer["autoload-dev"]["psr-4"]) || {};
  for (const [ns, dir] of Object.entries({ ...psr4, ...psr4Dev })) {
    const target = Array.isArray(dir) ? String(dir[0]) : String(dir);
    cfg.psr4.push({ namespace: ns.replace(/\\+$/, ""), dir: target.replace(/\/$/, "") });
  }
}

function buildResolverConfig(repoDir) {
  const cfg = { aliases: [], roots: [], psr4: [], packages: new Map() };
  collectTsconfig(repoDir, cfg);
  collectPackages(repoDir, cfg);
  collectComposer(repoDir, cfg);
  for (const r of ["src", "app", "lib", "server", "source"]) {
    if (fs.existsSync(path.join(repoDir, r))) cfg.roots.push(r);
  }
  return cfg;
}

/**
 * TypeScript's ESM output rule: source written as `./config.js` compiles from
 * `./config.ts`, so the specifier on disk is never the file on disk. Without
 * this swap every import in a modern TS codebase resolves to nothing.
 */
const JS_TO_TS = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** Node-style: exact file, then extensions, then directory index. */
function tryPath(candidate, known) {
  const clean = candidate.replace(/^\.\//, "").replace(/\/+/g, "/");
  if (known.has(clean)) return clean;

  const declared = path.posix.extname(clean);
  for (const swap of JS_TO_TS[declared] || []) {
    const swapped = clean.slice(0, -declared.length) + swap;
    if (known.has(swapped)) return swapped;
  }

  for (const ext of EXTENSIONS) if (known.has(clean + ext)) return clean + ext;

  for (const idx of INDEX_NAMES) {
    for (const ext of EXTENSIONS) {
      const p = path.posix.join(clean, idx + ext);
      if (known.has(p)) return p;
    }
  }

  // A directory import written with an extension: "./routes/index.js".
  if (declared && INDEX_NAMES.includes(path.posix.basename(clean, declared))) {
    const dir = path.posix.dirname(clean);
    for (const idx of INDEX_NAMES) {
      for (const ext of EXTENSIONS) {
        const p = path.posix.join(dir, idx + ext);
        if (known.has(p)) return p;
      }
    }
  }

  return null;
}

/**
 * Resolve one import specifier to a file we indexed. Returns null rather than
 * guessing: an unresolved import is better than a wrong edge.
 */
function resolveSpecifier(fromPath, spec, known, cfg) {
  if (!spec || spec.startsWith("http")) return null;

  // 1. Relative — the runtime's own rule, no ambiguity.
  if (spec.startsWith(".")) {
    const base = path.posix.join(path.posix.dirname(fromPath), spec);
    const hit = tryPath(base, known);
    return hit ? { target: hit, how: "relative" } : null;
  }

  if (spec.startsWith("/")) {
    const hit = tryPath(spec.slice(1), known);
    return hit ? { target: hit, how: "relative" } : null;
  }

  // 2. tsconfig / jsconfig path aliases.
  for (const alias of cfg.aliases) {
    if (!spec.startsWith(alias.prefix)) continue;
    const rest = spec.slice(alias.prefix.length);
    for (const target of alias.targets) {
      const hit = tryPath(alias.wildcard ? path.posix.join(target, rest) : target, known);
      if (hit) return { target: hit, how: "alias" };
    }
  }

  // 3. Workspace packages: "@acme/billing" or "@acme/billing/src/x".
  for (const [name, dir] of cfg.packages) {
    if (spec !== name && !spec.startsWith(`${name}/`)) continue;
    const rest = spec.slice(name.length).replace(/^\//, "");
    const hit =
      tryPath(path.posix.join(dir, rest), known) || tryPath(path.posix.join(dir, "src", rest), known);
    if (hit) return { target: hit, how: "workspace" };
  }

  // 4. PHP PSR-4: App\Http\Controllers\FooController -> app/Http/Controllers/FooController.php
  if (spec.includes("\\")) {
    const normalized = spec.replace(/^\\+/, "");
    for (const { namespace, dir } of cfg.psr4) {
      if (!normalized.startsWith(namespace)) continue;
      const rest = normalized.slice(namespace.length).replace(/^\\+/, "").replace(/\\/g, "/");
      const hit = tryPath(path.posix.join(dir, rest), known);
      if (hit) return { target: hit, how: "psr4" };
    }
  }

  // 5. baseUrl / conventional source roots for bare specifiers ("utils/date").
  if (!spec.startsWith("@") && spec.includes("/")) {
    for (const root of cfg.roots) {
      const hit = tryPath(path.posix.join(root, spec), known);
      if (hit) return { target: hit, how: "root" };
    }
    const hit = tryPath(spec, known);
    if (hit) return { target: hit, how: "root" };
  }

  return null;
}

module.exports = { buildResolverConfig, resolveSpecifier, readJson };
