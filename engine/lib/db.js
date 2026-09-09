"use strict";

const path = require("node:path");
const sqlite = require("./sqlite");
const { config } = require("./config");

const db = sqlite.open(path.join(config.dataDir, "repodeck.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
-- ── identity ────────────────────────────────────────────────────────────────
-- The signed-in GitHub user. Only the Keychain *ref* is stored, never a token.
CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT NOT NULL DEFAULT 'github',
  login        TEXT NOT NULL,
  name         TEXT,
  avatar_url   TEXT,
  scopes       TEXT,
  token_ref    TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, login)
);

-- ── model providers ─────────────────────────────────────────────────────────
-- kind: 'anthropic' | 'openai' | 'compatible' (any OpenAI-shaped endpoint:
-- Ollama, LM Studio, vLLM, OpenRouter, Azure). base_url is null for the
-- first-party clouds. key_ref points at the Keychain; local endpoints that
-- need no key leave it null.
CREATE TABLE IF NOT EXISTS providers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  base_url     TEXT,
  model        TEXT NOT NULL,
  fast_model   TEXT,
  key_ref      TEXT,
  effort       TEXT NOT NULL DEFAULT 'high',
  max_tokens   INTEGER NOT NULL DEFAULT 16000,
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (label)
);

-- ── repositories ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL UNIQUE,
  host              TEXT NOT NULL DEFAULT 'github.com',
  owner             TEXT,
  slug              TEXT,
  auth_type         TEXT NOT NULL DEFAULT 'none',   -- none | token | ssh
  credential_ref    TEXT,                            -- Keychain ref, never a secret
  default_branch    TEXT NOT NULL DEFAULT 'main',
  branch_auto       INTEGER NOT NULL DEFAULT 1,      -- let the app track the remote HEAD
  provider_id       INTEGER REFERENCES providers(id) ON DELETE SET NULL,

  status            TEXT NOT NULL DEFAULT 'new',     -- new|cloning|indexing|ready|error
  status_detail     TEXT,
  progress          TEXT,
  insight           TEXT,
  last_indexed_sha  TEXT,
  last_indexed_at   TEXT,
  last_pulled_at    TEXT,

  -- scheduling
  schedule_cron     TEXT,
  schedule_tz       TEXT,
  watch_prs         INTEGER NOT NULL DEFAULT 1,
  watch_interval_min INTEGER NOT NULL DEFAULT 60,
  last_watch_at     TEXT,

  -- pull / conflict policy
  pull_strategy     TEXT NOT NULL DEFAULT 'reset',   -- reset | merge
  ai_conflict_fix   INTEGER NOT NULL DEFAULT 0,      -- opt-in, reviewed before commit

  -- local deploy
  deploy_enabled    INTEGER NOT NULL DEFAULT 0,
  auto_deploy       INTEGER NOT NULL DEFAULT 0,
  deploy_profile    TEXT,                            -- JSON: install/run/env/health
  deploy_state      TEXT NOT NULL DEFAULT 'stopped', -- stopped|starting|running|failed
  deploy_pid        INTEGER,
  deploy_started_at TEXT,

  kg_built_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── architecture graph ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  ext            TEXT NOT NULL DEFAULT '',
  loc            INTEGER NOT NULL DEFAULT 0,
  layer          TEXT NOT NULL DEFAULT 'other',
  role           TEXT,
  summary        TEXT,
  module         TEXT,
  exports        TEXT,                                -- JSON array of symbol names
  commit_count   INTEGER NOT NULL DEFAULT 0,
  churn          INTEGER NOT NULL DEFAULT 0,
  heat           REAL NOT NULL DEFAULT 0,
  community      INTEGER NOT NULL DEFAULT -1,
  degree         INTEGER NOT NULL DEFAULT 0,
  last_change_at TEXT,
  deleted        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repo_id, path)
);
CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo_id, deleted);
CREATE INDEX IF NOT EXISTS idx_files_heat ON files(repo_id, heat DESC);

CREATE TABLE IF NOT EXISTS edges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  src_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dst_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL DEFAULT 'import',
  source    TEXT NOT NULL DEFAULT 'static',   -- static | llm
  weight    REAL NOT NULL DEFAULT 1,
  how       TEXT,                              -- how the specifier resolved
  evidence  TEXT,                              -- verbatim proving line, for llm edges
  UNIQUE (repo_id, src_id, dst_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_repo ON edges(repo_id);

-- ── symbols: the function-level graph ───────────────────────────────────────
-- The file graph says which files touch each other. This says what calls what,
-- which is the question a developer actually has in front of a flow diagram.
CREATE TABLE IF NOT EXISTS symbols (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,        -- function|method|class|component|hook|handler|type
  line          INTEGER NOT NULL DEFAULT 0,
  signature     TEXT,
  params        TEXT,
  exported      INTEGER NOT NULL DEFAULT 0,
  layer         TEXT,                 -- inherited from the owning file
  module        TEXT,
  purpose       TEXT,                 -- model-written, one line
  returns       TEXT,
  side_effects  TEXT,                 -- JSON array
  throws        TEXT,                 -- JSON array
  in_degree     INTEGER NOT NULL DEFAULT 0,
  out_degree    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repo_id, path, name)
);
CREATE INDEX IF NOT EXISTS idx_symbols_repo ON symbols(repo_id, deleted);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(repo_id, name);

CREATE TABLE IF NOT EXISTS symbol_edges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  src_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  dst_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL DEFAULT 'calls',   -- calls | renders
  line      INTEGER NOT NULL DEFAULT 0,
  evidence  TEXT,
  UNIQUE (repo_id, src_id, dst_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_symbol_edges_repo ON symbol_edges(repo_id);
-- The per-index degree recompute runs a correlated subquery per symbol against
-- both endpoints. Without these it is a full scan of the edge table per symbol,
-- which is quadratic on a repository of any size.
CREATE INDEX IF NOT EXISTS idx_symbol_edges_src ON symbol_edges(src_id);
CREATE INDEX IF NOT EXISTS idx_symbol_edges_dst ON symbol_edges(dst_id);

-- ── pull request digests ────────────────────────────────────────────────────
-- One plain-language summary per merged PR (or per merge commit when there is
-- no PR to read), written for a developer scanning what landed overnight.
CREATE TABLE IF NOT EXISTS pr_summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number       INTEGER,               -- null for a bare merge commit
  sha          TEXT,
  title        TEXT,
  author       TEXT,
  url          TEXT,
  merged_at    TEXT,
  headline     TEXT NOT NULL,
  overview     TEXT,                  -- 2-4 sentences, plain language
  features     TEXT,                  -- JSON array
  fixes        TEXT,                  -- JSON array
  refactors    TEXT,                  -- JSON array
  breaking     TEXT,                  -- JSON array
  review_files TEXT,                  -- JSON array {path, why}
  risk         TEXT,                  -- low | medium | high
  risk_reason  TEXT,
  commit_count INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  additions    INTEGER NOT NULL DEFAULT 0,
  deletions    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_pr_summaries_repo ON pr_summaries(repo_id, created_at DESC);

-- ── history ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sha          TEXT NOT NULL,
  short_sha    TEXT NOT NULL,
  author       TEXT,
  email        TEXT,
  message      TEXT,
  committed_at TEXT NOT NULL,
  is_merge     INTEGER NOT NULL DEFAULT 1,
  pr_number    TEXT,
  UNIQUE (repo_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_commits_repo_date ON commits(repo_id, committed_at DESC);

CREATE TABLE IF NOT EXISTS file_changes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  UNIQUE (commit_id, path)
);
CREATE INDEX IF NOT EXISTS idx_changes_repo_path ON file_changes(repo_id, path);

-- Open and recently merged pull requests, from the GitHub API.
CREATE TABLE IF NOT EXISTS pull_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  title       TEXT,
  author      TEXT,
  state       TEXT,                     -- open | merged | closed
  base_branch TEXT,
  head_branch TEXT,
  merge_sha   TEXT,
  url         TEXT,
  updated_at  TEXT,
  merged_at   TEXT,
  seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  ingested    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_prs_repo ON pull_requests(repo_id, state);

-- ── knowledge graph (what gets exported for Claude agents) ──────────────────
-- One row per document. The "kind" column gives the document its shape; "body" is JSON.
CREATE TABLE IF NOT EXISTS kg_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,   -- overview|module|flow|convention|changelog|glossary
  key        TEXT NOT NULL,   -- stable slug, unique per (repo, kind)
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,   -- JSON
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_kg_repo ON kg_docs(repo_id, kind);

-- The API surface: what an agent must know to call this codebase.
CREATE TABLE IF NOT EXISTS endpoints (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  method         TEXT NOT NULL,
  path           TEXT NOT NULL,
  handler_path   TEXT,
  handler_symbol TEXT,
  module         TEXT,
  auth           TEXT,
  middleware     TEXT,   -- JSON array
  request_shape  TEXT,   -- JSON: params/query/body fields with types + required
  response_shape TEXT,   -- JSON: success + error shapes
  status_codes   TEXT,   -- JSON array
  summary        TEXT,
  evidence       TEXT,
  UNIQUE (repo_id, method, path)
);
CREATE INDEX IF NOT EXISTS idx_endpoints_repo ON endpoints(repo_id);

-- Data models the endpoints move around.
CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  file_path  TEXT,
  store      TEXT,     -- table / collection name
  fields     TEXT,     -- JSON array {name,type,required,note}
  relations  TEXT,     -- JSON array {to,kind,via}
  summary    TEXT,
  UNIQUE (repo_id, name)
);

-- Screens and what each one talks to — the "which page is connected to what" map.
CREATE TABLE IF NOT EXISTS screens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  route       TEXT,
  file_path   TEXT,
  components  TEXT,   -- JSON array of file paths
  calls       TEXT,   -- JSON array of "METHOD /path"
  summary     TEXT,
  UNIQUE (repo_id, name)
);

-- Environment variables the repo reads, so an agent can configure a run.
CREATE TABLE IF NOT EXISTS env_vars (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  required  INTEGER NOT NULL DEFAULT 0,
  example   TEXT,
  used_in   TEXT,   -- JSON array of file paths
  note      TEXT,
  UNIQUE (repo_id, name)
);

-- ── traced flows, errors and tests ──────────────────────────────────────────
-- These are derived from the call graph rather than asked of a model: a request
-- path an agent is told to trust has to be provable, not plausible.
CREATE TABLE IF NOT EXISTS flows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,      -- "POST /repos"
  entry_path  TEXT NOT NULL,
  entry_line  INTEGER NOT NULL DEFAULT 0,
  module      TEXT,
  steps       TEXT NOT NULL,      -- JSON [{depth,name,kind,path,line,callLine,layer}]
  depth       INTEGER NOT NULL DEFAULT 0,
  touches     TEXT,               -- JSON array of layers reached
  summary     TEXT,
  UNIQUE (repo_id, key, entry_path)
);
CREATE INDEX IF NOT EXISTS idx_flows_repo ON flows(repo_id);

CREATE TABLE IF NOT EXISTS error_catalog (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,        -- throw | http-status | reject | log-error
  label     TEXT NOT NULL,        -- the message or status, verbatim
  path      TEXT NOT NULL,
  line      INTEGER NOT NULL DEFAULT 0,
  symbol    TEXT,
  module    TEXT,
  evidence  TEXT,
  meaning   TEXT,                 -- model-written: what it means, what to check
  UNIQUE (repo_id, path, line, label)
);
CREATE INDEX IF NOT EXISTS idx_errors_repo ON error_catalog(repo_id);

CREATE TABLE IF NOT EXISTS test_map (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  test_path   TEXT NOT NULL,
  covers_path TEXT NOT NULL,
  cases       TEXT,               -- JSON array of test names
  UNIQUE (repo_id, test_path, covers_path)
);
CREATE INDEX IF NOT EXISTS idx_testmap_repo ON test_map(repo_id, covers_path);

-- ── run log ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,   -- clone|index|sync|pull|deploy|kg|watch
  status      TEXT NOT NULL DEFAULT 'running',
  message     TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_repo ON jobs(repo_id, id DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

/** Additive column migrations. Safe to re-run on every boot. */
const migrations = [
  // [table, sql] — add new columns here rather than editing the CREATE above.

  // A fingerprint of the source the model described. Without it, a function
  // contract written months ago was never re-derived while the name survived,
  // so the exported graph asserted behaviour for an implementation that had
  // since been rewritten — the most expensive kind of wrong, because an agent
  // reads it as fact.
  ["symbols", `ALTER TABLE symbols ADD COLUMN source_sha TEXT`],
];
for (const [table, sql] of migrations) {
  const col = sql.split("ADD COLUMN ")[1].split(" ")[0];
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some((c) => c.name === col)) db.exec(sql);
}

// ── small helpers used across the engine ──────────────────────────────────────

function getSetting(key, fallback = null) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value == null ? null : String(value));
}

/** Parse a JSON column without letting one bad row take down a whole query. */
function json(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function startJob(repoId, type) {
  const info = db.prepare(`INSERT INTO jobs (repo_id, type) VALUES (?, ?)`).run(repoId, type);
  return info.lastInsertRowid;
}

function finishJob(jobId, status, message) {
  db.prepare(
    `UPDATE jobs SET status = ?, message = ?, finished_at = datetime('now') WHERE id = ?`,
  ).run(status, message ?? null, jobId);
}

module.exports = { db, getSetting, setSetting, json, startJob, finishJob };
