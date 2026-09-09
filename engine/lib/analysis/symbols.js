"use strict";

// Function-level extraction.
//
// The file graph answers "which files touch each other". The question a
// developer actually asks in front of a flow diagram is narrower: *what calls
// what*. That needs symbols — the functions, classes, components and handlers a
// file exports — and the call sites that reach them.
//
// Everything here is static and line-anchored. A symbol carries the line it is
// declared on and the verbatim line of every call site, so both the graph and
// the knowledge graph can point an agent at `path:line` rather than at a file
// and a shrug.

const KINDS = {
  module: "module",
  function: "function",
  method: "method",
  class: "class",
  component: "component",
  hook: "hook",
  handler: "handler",
  constant: "constant",
  type: "type",
};

/**
 * One pattern per declaration form, matched a line at a time.
 *
 * Line-at-a-time rather than one global regex: the line number is the point of
 * the whole exercise, and recovering it from a global match index means
 * counting newlines in the prefix for every hit.
 */
const DECLARATIONS = [
  // ── JavaScript / TypeScript ───────────────────────────────────────────────
  { re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/, kind: "function", exported: true },
  { re: /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/, kind: "function", exported: false },
  { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function", exported: true },
  { re: /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function", exported: false },
  { re: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", exported: true },
  { re: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", exported: false },
  { re: /^\s*export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/, kind: "type", exported: true },
  { re: /^\s*exports\.([A-Za-z_$][\w$]*)\s*=/, kind: "function", exported: true },
  // A class method: indented, not a control keyword, followed by a parameter list and a brace.
  { re: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*(\([^)]*\))\s*\{/, kind: "method", exported: false },

  // ── PHP ───────────────────────────────────────────────────────────────────
  { re: /^\s*(?:public|protected|private)?\s*(?:static\s+)?function\s+([A-Za-z_][\w]*)\s*(\([^)]*\))/, kind: "method", exported: true },
  { re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/, kind: "class", exported: true },

  // ── Python ────────────────────────────────────────────────────────────────
  { re: /^\s*(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*(\([^)]*\))/, kind: "function", exported: true },

  // ── Go ────────────────────────────────────────────────────────────────────
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*(\([^)]*\))/, kind: "function", exported: true },

  // ── Ruby ──────────────────────────────────────────────────────────────────
  { re: /^\s*def\s+(?:self\.)?([a-z_][\w?!]*)/, kind: "method", exported: true },
];

/** Keywords that look like calls but are not. */
const NOT_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "await",
  "new", "super", "this", "require", "import", "export", "console", "describe", "it",
  "test", "expect", "constructor", "class", "else", "do", "try", "throw", "yield",
  "String", "Number", "Boolean", "Array", "Object", "JSON", "Math", "Date", "Promise",
  "Set", "Map", "Error", "parseInt", "parseFloat", "isNaN", "print", "len", "range",
  "def", "self", "puts", "func", "make", "append", "panic", "recover", "defer",
]);

/**
 * Blank out string and template-literal contents before looking for calls.
 *
 * Without this an embedded SQL statement reads as a burst of function calls —
 * `jobs(`, `VALUES(`, `datetime(` — and a repository full of query builders
 * ends up with a call graph made of syntax.
 */
function stripLiterals(source) {
  return source
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => "`" + " ".repeat(Math.max(0, m.length - 2)) + "`")
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => "'" + " ".repeat(Math.max(0, m.length - 2)) + "'")
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => '"' + " ".repeat(Math.max(0, m.length - 2)) + '"');
}

/** A React component: capitalised, and the body mentions JSX or a hook. */
function looksLikeComponent(name, body) {
  return /^[A-Z]/.test(name) && /(<[A-Z][\w.]*|<\/|jsx|useState|useEffect|return\s*\()/.test(body);
}

function looksLikeHook(name) {
  return /^use[A-Z]/.test(name);
}

/** A request handler: takes (req, res) or ($request) or is bound in a route line. */
function looksLikeHandler(signature) {
  return /\(\s*(req|request|ctx|context)\b|\$request|\(\s*w\s+http\.ResponseWriter/.test(signature || "");
}

/**
 * Extract every declaration in a file, with its line, its signature, and a short
 * slice of its body for classification.
 */
function extractSymbols(source, filePath) {
  const lines = source.split("\n");
  const found = new Map(); // name -> symbol (first declaration wins)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 400) continue;
    // Comment lines produce phantom symbols; skip them cheaply.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;

    for (const rule of DECLARATIONS) {
      const m = line.match(rule.re);
      if (!m) continue;
      const name = m[1];
      if (!name || NOT_CALLS.has(name) || found.has(name)) continue;

      const signature = trimmed.slice(0, 220);
      const body = lines.slice(i, Math.min(i + 25, lines.length)).join("\n");

      let kind = rule.kind;
      if (kind === "function" || kind === "method") {
        if (looksLikeHook(name)) kind = KINDS.hook;
        else if (looksLikeComponent(name, body)) kind = KINDS.component;
        else if (looksLikeHandler(m[2])) kind = KINDS.handler;
      }

      found.set(name, {
        name,
        kind,
        line: i + 1,
        signature,
        params: m[2] ? m[2].replace(/^\(|\)$/g, "").trim() : "",
        exported: rule.exported,
        file: filePath,
      });
      break; // one declaration per line
    }
  }

  return [...found.values()];
}

/**
 * Route handlers, as symbols in their own right.
 *
 * Express, Laravel and Flask all bind a URL to an anonymous function. Without
 * these, every call inside a route file attributes to whatever named helper
 * happens to sit above it — so one function appears to call the entire
 * application. Naming the handler after its route fixes the attribution *and*
 * puts the thing a developer actually looks for ("where does POST /repos go?")
 * on the graph as a node.
 */
const ROUTE_BINDINGS = [
  // <anything>.get("/path", …) — the router is named by the team, not by the
  // framework: reposRouter, graphRouter, userRoutes, r. What identifies a route
  // is the shape of the call, not the receiver's name.
  {
    re: /(?:^|[^\w.])[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|use|all|options|head)\s*\(\s*['"`](\/[^'"`]*|)['"`]/i,
    verb: 1,
    path: 2,
    needsHandler: true,
  },
  // Route::get('/repos', …)
  { re: /Route::(get|post|put|patch|delete|any|match)\s*\(\s*['"`]([^'"`]+)['"`]/i, verb: 1, path: 2 },
  // @app.route("/x", methods=["POST"])
  { re: /@(?:app|bp|blueprint)\.route\s*\(\s*['"`]([^'"`]+)['"`]/i, verb: null, path: 1 },
  // NestJS / Spring decorators: @Get('x')  @PostMapping("/x")
  { re: /@(Get|Post|Put|Patch|Delete)(?:Mapping)?\s*\(\s*['"`]([^'"`]*)['"`]/, verb: 1, path: 2 },
];

/** A route binds a handler. An HTTP client call to the same-looking path does not. */
const HANDLER_SHAPE = /=>|\bfunction\b|\(\s*_?req\b|\(\s*request\b|\(\s*ctx\b|::class/;

function extractRouteHandlers(source) {
  const lines = source.split("\n");
  const handlers = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 400) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;

    for (const rule of ROUTE_BINDINGS) {
      const m = line.match(rule.re);
      if (!m) continue;

      const routePath = m[rule.path];
      if (routePath === undefined) continue;

      const method = (rule.verb ? m[rule.verb] : "GET").toUpperCase();

      // A mount — `app.use("/api/repos", reposRouter)` — binds a router rather
      // than a handler, and it is the thing that tells you what prefix every
      // route in that file actually lives under. Worth a node of its own.
      const isMount = method === "USE" && routePath.startsWith("/");

      if (rule.needsHandler && !isMount) {
        // Look at this line and the next: multi-line route definitions put the
        // handler on the following line.
        const window = line + "\n" + (lines[i + 1] || "");
        if (!HANDLER_SHAPE.test(window)) continue;
      }
      if (method === "USE" && !isMount) continue;

      const name = `${method} ${routePath || "/"}`;
      if (!handlers.has(name)) {
        handlers.set(name, {
          name,
          kind: KINDS.handler,
          line: i + 1,
          signature: trimmed.slice(0, 220),
          params: "",
          exported: true,
          route: routePath || "/",
          method,
        });
      }
      break;
    }
  }

  return [...handlers.values()];
}

/**
 * Every identifier this file calls, with the line it is called on.
 *
 * Deliberately over-collects: resolution against a real symbol table happens
 * later, and a call site that resolves to nothing is simply dropped. The
 * verbatim line is kept because it is the evidence a reader needs to believe
 * the edge.
 */
function extractCallSites(source) {
  const lines = stripLiterals(source).split("\n");
  const calls = new Map(); // name -> { name, line, text }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 500) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;

    // bare calls: foo(   and member calls: obj.foo(
    for (const m of line.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (NOT_CALLS.has(name) || name.length < 2) continue;
      if (calls.has(name)) continue;
      calls.set(name, { name, line: i + 1, text: trimmed.slice(0, 200) });
    }
    for (const m of line.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (NOT_CALLS.has(name) || name.length < 3) continue;
      const key = `.${name}`;
      if (calls.has(key)) continue;
      calls.set(key, { name, line: i + 1, text: trimmed.slice(0, 200), member: true });
    }
  }

  return [...calls.values()];
}

/**
 * JSX/Vue components a file renders, so the page → component edges in the flow
 * view come from the markup rather than from an inference.
 */
function extractRenderedComponents(source) {
  const rendered = new Map();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // The negative lookbehind is what separates JSX from a generic type
    // argument: `<Legend />` follows a space or a brace, `useState<Repo>`
    // follows an identifier character. Without it every typed hook call in the
    // codebase is reported as a rendered component.
    // The trailing lookahead has to accept end-of-line: multi-line JSX puts the
    // props on the following lines, so `<RepoForm` is the whole line.
    for (const m of lines[i].matchAll(/(?<![\w>])<([A-Z][\w.]*)(?=[\s/>]|$)/g)) {
      const name = m[1].split(".")[0];
      if (!rendered.has(name)) rendered.set(name, { name, line: i + 1, text: lines[i].trim().slice(0, 200) });
    }
  }
  return [...rendered.values()];
}

module.exports = {
  extractSymbols,
  extractCallSites,
  extractRenderedComponents,
  extractRouteHandlers,
  moduleScopeSymbol,
  KINDS,
};

/**
 * Which declaration encloses a given line.
 *
 * A call site on line 214 belongs to whichever function was declared most
 * recently above it. That is an approximation — it ignores nesting depth — but
 * it is right for the shape almost all real code takes, and it is the
 * difference between "this file calls indexRepo" and "syncRepo calls indexRepo".
 */
/**
 * A stand-in for module scope.
 *
 * Plenty of consequential code runs at the top level of a file — a server
 * bootstrapping, routes being registered, a client being constructed. Those
 * calls have no enclosing function, so without this they produced no edge at
 * all, and the bootstrap file of an application looked like a leaf.
 */
function moduleScopeSymbol(filePath) {
  const base = filePath.split("/").pop() || filePath;
  return {
    name: base,
    kind: KINDS.module,
    line: 1,
    signature: `module scope of ${filePath}`,
    params: "",
    exported: true,
    moduleScope: true,
  };
}

function enclosingSymbol(sortedSymbols, line, maxDistance = 400) {
  let found = null;
  for (const symbol of sortedSymbols) {
    if (symbol.line <= line) found = symbol;
    else break;
  }
  // Far enough above and it is not the enclosing scope, it is just the last
  // thing that happened to be declared — an attribution nobody should trust.
  if (found && line - found.line > maxDistance) return null;
  return found;
}

module.exports.enclosingSymbol = enclosingSymbol;
