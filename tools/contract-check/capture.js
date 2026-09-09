// Capture one real payload per RPC, so each can be decoded with the app's own type.
//
// Driven by run.sh. REPODECK_HOME selects the database; OUT is where the payloads
// and their manifest are written.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const OUT = process.env.OUT;
fs.mkdirSync(OUT, { recursive: true });

const ENGINE = path.resolve(__dirname, "..", "..", "engine", "index.js");
const child = spawn(process.execPath, [ENGINE, "daemon"],
  { env: process.env, stdio: ["pipe", "pipe", "ignore"] });
let buf = "", id = 1; const pending = new Map();
child.stdout.on("data", d => { buf += d; let nl;
  while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl+1);
    if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); } } });
const call = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); child.stdin.write(JSON.stringify({ id: i, method, params }) + "\n"); });

const CASES = [
  ["AppState",         "app.state",        {}],
  ["RepoListResult",   "repo.list",        {}],
  ["Repo",             "repo.get",         { repoId: 1 }],
  ["GraphData",        "graph.get",        { repoId: 1, nodes: "file" }],
  ["GraphData",        "graph.get",        { repoId: 1, nodes: "symbol" }],
  ["GraphData",        "graph.get",        { repoId: 1, nodes: "folder" }],
  ["GraphData",        "graph.get",        { repoId: 1, nodes: "feature" }],
  ["HotspotList",      "graph.hotspots",   { repoId: 1, limit: 5 }],
  ["CommitList",       "graph.commits",    { repoId: 1, limit: 5 }],
  ["ActivityResult",   "graph.activity",   { repoId: 1 }],
  ["KnowledgeGraph",   "kg.get",           { repoId: 1 }],
  ["JobList",          "repo.jobs",        { repoId: 1, limit: 5 }],
  ["PullRequestList",  "prs.list",         { repoId: 1 }],
  ["PRSummaryList",    "prs.summaries",    { repoId: 1 }],
  ["DeployStatus",     "deploy.status",    { repoId: 1 }],
  ["DeployDetection",  "deploy.detect",    { repoId: 1 }],
  ["LogResult",        "deploy.logs",      { repoId: 1, tail: 5 }],
  ["WorktreeStatus",   "repo.status",      { repoId: 1 }],
  ["MarkdownResult",   "kg.claudeMd",      { repoId: 1 }],
];

(async () => {
  await new Promise(r => setTimeout(r, 500));
  await call("app.secrets", { secrets: {} });

  // A file and a symbol detail need a real key from the graph.
  const g = await call("graph.get", { repoId: 1, nodes: "file" });
  if (g.nodes[0]) CASES.push(["FileDetail", "graph.file", { repoId: 1, path: g.nodes[0].path }]);
  const sg = await call("graph.get", { repoId: 1, nodes: "symbol" });
  if (sg.nodes[0]) CASES.push(["SymbolDetail", "graph.symbol", { repoId: 1, path: sg.nodes[0].path, name: sg.nodes[0].label }]);

  const manifest = [];
  for (const [type, method, params] of CASES) {
    try {
      const result = await call(method, params);
      const name = `${type}__${method.replace(/\./g, "_")}__${JSON.stringify(params.nodes || "")}`.replace(/[^\w]/g, "_") + ".json";
      fs.writeFileSync(path.join(OUT, name), JSON.stringify(result, null, 1));
      manifest.push({ type, method, file: name });
    } catch (e) {
      console.log(`  SKIP ${method}: ${e.message.slice(0, 70)}`);
    }
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(`captured ${manifest.length} payloads`);
  await call("app.shutdown").catch(() => {});
  setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
