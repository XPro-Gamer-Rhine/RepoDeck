"use strict";

// Repository, account and provider bookkeeping.
//
// Adding a repo is deliberately two steps: inspect the remote (which branches
// exist, which one is HEAD), then create the row. That way the branch picker
// has real data in it before anything is written to disk, and a typo in a URL
// fails in a dialog rather than halfway through a clone.

const fs = require("node:fs");
const { db, json: parseJson } = require("./db");
const { config } = require("./config");
const { emit } = require("./events");
const git = require("./git");
const github = require("./github");
const secrets = require("./secrets");

// ── accounts ─────────────────────────────────────────────────────────────────

/**
 * Record a verified GitHub identity. The token itself has already gone into the
 * Keychain by the time this runs; `tokenRef` is the account name it went under.
 */
async function saveAccount(tokenRef) {
  const token = secrets.require(tokenRef, "The GitHub token");
  const me = await github.whoami(token);

  db.prepare(`UPDATE accounts SET is_active = 0 WHERE provider = 'github'`).run();
  db.prepare(
    `INSERT INTO accounts (provider, login, name, avatar_url, scopes, token_ref, is_active)
     VALUES ('github', ?, ?, ?, ?, ?, 1)
     ON CONFLICT(provider, login) DO UPDATE SET
       name = excluded.name, avatar_url = excluded.avatar_url, scopes = excluded.scopes,
       token_ref = excluded.token_ref, is_active = 1`,
  ).run(me.login, me.name, me.avatarUrl, me.scopes.join(","), tokenRef);

  emit({ t: "account_changed", login: me.login });
  return me;
}

function activeAccount() {
  const row = db
    .prepare(`SELECT * FROM accounts WHERE provider = 'github' AND is_active = 1 LIMIT 1`)
    .get();
  if (!row) return null;
  return {
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    scopes: (row.scopes || "").split(",").filter(Boolean),
    tokenRef: row.token_ref,
    unlocked: secrets.has(row.token_ref),
  };
}

function signOut() {
  db.prepare(`UPDATE accounts SET is_active = 0 WHERE provider = 'github'`).run();
  emit({ t: "account_changed", login: null });
  return { signedOut: true };
}

function accountToken() {
  const account = activeAccount();
  return account ? secrets.get(account.tokenRef) : null;
}

// ── providers ────────────────────────────────────────────────────────────────

function saveProvider(input) {
  const isDefault = input.isDefault ? 1 : 0;
  if (input.id) {
    db.prepare(
      `UPDATE providers SET label = ?, kind = ?, base_url = ?, model = ?, fast_model = ?,
              key_ref = ?, effort = ?, max_tokens = ?, is_default = ?
       WHERE id = ?`,
    ).run(
      input.label,
      input.kind,
      input.baseUrl || null,
      input.model,
      input.fastModel || null,
      input.keyRef || null,
      input.effort || "high",
      input.maxTokens || 16000,
      isDefault,
      input.id,
    );
  } else {
    const info = db
      .prepare(
        `INSERT INTO providers (label, kind, base_url, model, fast_model, key_ref, effort, max_tokens, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.label,
        input.kind,
        input.baseUrl || null,
        input.model,
        input.fastModel || null,
        input.keyRef || null,
        input.effort || "high",
        input.maxTokens || 16000,
        isDefault,
      );
    input.id = info.lastInsertRowid;
  }

  // Exactly one default, always.
  if (isDefault) {
    db.prepare(`UPDATE providers SET is_default = 0 WHERE id != ?`).run(input.id);
  } else if (!db.prepare(`SELECT 1 FROM providers WHERE is_default = 1`).get()) {
    db.prepare(`UPDATE providers SET is_default = 1 WHERE id = ?`).run(input.id);
  }

  emit({ t: "providers_changed" });
  return { id: input.id };
}

function deleteProvider(id) {
  db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
  if (!db.prepare(`SELECT 1 FROM providers WHERE is_default = 1`).get()) {
    const first = db.prepare(`SELECT id FROM providers ORDER BY id LIMIT 1`).get();
    if (first) db.prepare(`UPDATE providers SET is_default = 1 WHERE id = ?`).run(first.id);
  }
  emit({ t: "providers_changed" });
  return { deleted: true };
}

// ── repositories ─────────────────────────────────────────────────────────────

/**
 * Look at a remote without cloning it: which branches exist, and which one the
 * remote itself calls HEAD. The answer drives the branch picker, and the "auto"
 * setting later re-reads it so a team switching `master` to `main` doesn't leave
 * the app watching a dead branch.
 */
async function inspectRemote({ url, authType = "none", credentialRef = null }) {
  const creds = { url: url.trim(), auth_type: authType, credential_ref: credentialRef };
  const remote = git.parseRemote(creds.url);

  // GitHub can answer this without a network round trip through git, and it also
  // tells us whether the repo is private before we try to clone it.
  const token = accountToken();
  if (token && remote.host === "github.com" && remote.owner && remote.name) {
    try {
      const info = await github.getRepo(token, remote.owner, remote.name);
      const branches = await github.listBranchNames(token, remote.owner, remote.name);
      if (branches.length === 0) {
        throw new Error(
          "That repository has no commits yet, so there is nothing to index. Push something to it first.",
        );
      }
      return {
        ...remote,
        branches,
        suggested: info.defaultBranch || git.pickDefault(branches),
        private: info.private,
        description: info.description,
        language: info.language,
        via: "api",
      };
    } catch {
      // Fall through to git — the token may not cover this repository.
    }
  }

  const { branches, head } = await git.listBranches(creds);
  if (branches.length === 0) {
    // A repository with no commits has no branches to clone, and git's own
    // message for that ("Remote branch main not found in upstream origin",
    // wrapped in a clone progress dump) is not something a user can act on.
    // Refuse here, before a row is written — otherwise a failed add leaves a
    // permanently broken entry that only a manual remove clears.
    throw new Error(
      "That repository has no commits yet, so there is nothing to index. Push something to it first.",
    );
  }
  return { ...remote, branches, suggested: head, private: null, via: "git" };
}

function addRepo(input) {
  const url = String(input.url || "").trim();
  if (!url) throw new Error("Paste a repository URL — SSH or HTTPS.");

  const existing = db.prepare(`SELECT id, name FROM repos WHERE url = ?`).get(url);
  if (existing) throw new Error(`${existing.name} is already added.`);

  const remote = git.parseRemote(url);
  const authType = input.authType || (url.startsWith("http") ? (input.credentialRef ? "token" : "none") : "ssh");

  const info = db
    .prepare(
      `INSERT INTO repos
         (name, url, host, owner, slug, auth_type, credential_ref, default_branch, branch_auto,
          provider_id, schedule_cron, schedule_tz, watch_prs, watch_interval_min,
          pull_strategy, ai_conflict_fix, auto_deploy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name || remote.name,
      url,
      remote.host,
      remote.owner,
      git.repoSlug(url),
      authType,
      input.credentialRef || null,
      input.branch || "main",
      input.branchAuto === false ? 0 : 1,
      input.providerId || null,
      input.cron || config.defaults.scheduleCron,
      input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      input.watchPrs === false ? 0 : 1,
      input.watchIntervalMin || config.defaults.watchIntervalMin,
      input.pullStrategy || "reset",
      input.aiConflictFix ? 1 : 0,
      input.autoDeploy ? 1 : 0,
    );

  emit({ t: "repos_changed" });
  return { repoId: info.lastInsertRowid };
}

const UPDATABLE = {
  name: "name",
  branch: "default_branch",
  branchAuto: "branch_auto",
  providerId: "provider_id",
  cron: "schedule_cron",
  timezone: "schedule_tz",
  watchPrs: "watch_prs",
  watchIntervalMin: "watch_interval_min",
  pullStrategy: "pull_strategy",
  aiConflictFix: "ai_conflict_fix",
  autoDeploy: "auto_deploy",
  deployEnabled: "deploy_enabled",
  credentialRef: "credential_ref",
  authType: "auth_type",
};

function updateRepo(repoId, patch) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (typeof value === "boolean") value = value ? 1 : 0;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return getRepo(repoId);

  db.prepare(`UPDATE repos SET ${sets.join(", ")} WHERE id = ?`).run(...values, repoId);
  emit({ t: "repos_changed", repoId });
  return getRepo(repoId);
}

/** Re-read the remote's own HEAD and follow it, for repos left on "auto". */
async function refreshDefaultBranch(repoId) {
  const repo = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);
  if (!repo || !repo.branch_auto) return { changed: false };

  const info = await inspectRemote({
    url: repo.url,
    authType: repo.auth_type,
    credentialRef: repo.credential_ref,
  });
  if (!info.suggested || info.suggested === repo.default_branch) return { changed: false };

  db.prepare(`UPDATE repos SET default_branch = ? WHERE id = ?`).run(info.suggested, repoId);
  emit({ t: "branch_changed", repoId, from: repo.default_branch, to: info.suggested });
  return { changed: true, from: repo.default_branch, to: info.suggested };
}

function removeRepo(repoId, { deleteFiles = false } = {}) {
  const repo = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);
  if (!repo) return { removed: false };

  db.prepare(`DELETE FROM repos WHERE id = ?`).run(repoId); // cascades to every child table

  if (deleteFiles) {
    const dir = git.workdirFor(repoId, repo.url);
    // Only ever inside our own workspace directory — never a path the user typed.
    if (dir.startsWith(config.workspaceDir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  emit({ t: "repos_changed", repoId });
  return { removed: true, filesDeleted: deleteFiles };
}

function shape(row) {
  if (!row) return null;
  const openPrs = db
    .prepare(`SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ? AND state = 'open'`)
    .get(row.id).n;
  const files = db
    .prepare(`SELECT COUNT(*) AS n FROM files WHERE repo_id = ? AND deleted = 0`)
    .get(row.id).n;

  return {
    id: row.id,
    name: row.name,
    url: row.url,
    host: row.host,
    owner: row.owner,
    authType: row.auth_type,
    credentialRef: row.credential_ref,
    branch: row.default_branch,
    branchAuto: Boolean(row.branch_auto),
    providerId: row.provider_id,
    status: row.status,
    statusDetail: row.status_detail,
    progress: row.progress,
    insight: row.insight,
    lastIndexedSha: row.last_indexed_sha,
    lastIndexedAt: row.last_indexed_at,
    lastPulledAt: row.last_pulled_at,
    cron: row.schedule_cron,
    timezone: row.schedule_tz,
    watchPrs: Boolean(row.watch_prs),
    watchIntervalMin: row.watch_interval_min,
    lastWatchAt: row.last_watch_at,
    pullStrategy: row.pull_strategy,
    aiConflictFix: Boolean(row.ai_conflict_fix),
    deployEnabled: Boolean(row.deploy_enabled),
    autoDeploy: Boolean(row.auto_deploy),
    deployState: row.deploy_state,
    deployPid: row.deploy_pid,
    deployProfile: parseJson(row.deploy_profile, null),
    kgBuiltAt: row.kg_built_at,
    createdAt: row.created_at,
    counts: { files, openPrs },
    cloned: git.isCloned(git.workdirFor(row.id, row.url)),
    workdir: git.workdirFor(row.id, row.url),
  };
}

function getRepo(repoId) {
  return shape(db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId));
}

function listRepos() {
  return db.prepare(`SELECT * FROM repos ORDER BY name`).all().map(shape);
}

function listPullRequests(repoId) {
  return db
    .prepare(
      `SELECT number, title, author, state, base_branch, head_branch, url, updated_at, merged_at, ingested
       FROM pull_requests WHERE repo_id = ? ORDER BY updated_at DESC LIMIT 100`,
    )
    .all(repoId);
}

function listJobs(repoId, limit = 40) {
  return db
    .prepare(
      `SELECT id, type, status, message, started_at, finished_at
       FROM jobs WHERE repo_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(repoId, limit);
}

module.exports = {
  saveAccount,
  activeAccount,
  accountToken,
  signOut,
  saveProvider,
  deleteProvider,
  inspectRemote,
  addRepo,
  updateRepo,
  refreshDefaultBranch,
  removeRepo,
  getRepo,
  listRepos,
  listPullRequests,
  listJobs,
};
