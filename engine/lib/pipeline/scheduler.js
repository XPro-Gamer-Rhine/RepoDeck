"use strict";

// Two clocks per repository.
//
//   cron    — the schedule the user picked ("every day at 09:15 Asia/Dhaka").
//             Fires a full sync: fetch, update, re-index what changed.
//   watcher — a shorter loop (an hour by default) that asks GitHub whether the
//             default branch moved or a pull request merged. It is cheap: one
//             API call, no clone, no model.
//
// Both funnel into the same pipeline, and both refuse to start a run while the
// previous one is still going.

const cron = require("node-cron");
const { db, startJob, finishJob } = require("../db");
const { config } = require("../config");
const { emit, progress } = require("../events");
const github = require("../github");
const git = require("../git");
const secrets = require("../secrets");
const { indexRepo, isRunning } = require("./ingest");
const conflict = require("./conflict");
const deploy = require("./deploy");

/** repoId -> ScheduledTask */
const cronTasks = new Map();
/** repoId -> interval handle */
const watchers = new Map();

function isValidCron(expr) {
  return cron.validate(expr);
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function activeToken() {
  const account = db
    .prepare(`SELECT token_ref FROM accounts WHERE provider = 'github' AND is_active = 1 LIMIT 1`)
    .get();
  return account ? secrets.get(account.token_ref) : null;
}

// ── the run every trigger shares ─────────────────────────────────────────────

/**
 * Bring one repo to the latest default-branch code and put the results
 * everywhere they belong: graph, knowledge graph, running process.
 *
 * `reason` is recorded so the UI can say why something happened at 3am.
 */
async function syncRepo(repoId, reason) {
  const repo = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);
  if (!repo) return { skipped: "gone" };
  if (isRunning(repoId)) return { skipped: "already running" };

  emit({ t: "sync_start", repoId, reason });

  try {
    const result = await indexRepo(repoId, { full: false });

    // A conflict stops the pipeline. With AI resolution turned on we try once,
    // unattended, and only for resolutions the model is confident in.
    if (result.blocked) {
      if (!repo.ai_conflict_fix) {
        emit({ t: "sync_blocked", repoId, conflicts: result.conflicts, reason: "conflict" });
        return { blocked: true, conflicts: result.conflicts };
      }
      progress("sync", "Resolving merge conflicts", { repoId });
      const resolved = await conflict.autoResolve(repoId);
      if (resolved.blocked) {
        emit({ t: "sync_blocked", repoId, conflicts: result.conflicts, reason: "needs review" });
        return { blocked: true, conflicts: result.conflicts, resolutions: resolved.resolutions };
      }
      // The tree is clean now — index the merge we just made.
      return syncRepo(repoId, `${reason} (after conflict resolution)`);
    }

    if (result.upToDate) {
      emit({ t: "sync_done", repoId, reason, changed: false });
      return { changed: false };
    }

    // Redeploy only when the app is meant to be running and something landed.
    const fresh = db.prepare(`SELECT auto_deploy, deploy_enabled, deploy_state FROM repos WHERE id = ?`).get(repoId);
    if (fresh && fresh.auto_deploy && fresh.deploy_enabled) {
      const changed = db
        .prepare(
          `SELECT DISTINCT fc.path AS path
           FROM file_changes fc
           JOIN commits c ON c.id = fc.commit_id
           WHERE fc.repo_id = ? AND c.sha != ? AND c.committed_at >= datetime('now', '-30 days')`,
        )
        .all(repoId, result.previousSha || "")
        .map((r) => r.path);
      progress("sync", "Redeploying with the new code", { repoId });
      await deploy.redeploy(repoId, changed).catch((err) => {
        emit({ t: "deploy_error", repoId, message: err.message });
      });
    }

    emit({ t: "sync_done", repoId, reason, changed: true, sha: result.sha, commits: result.commits });
    return { changed: true, ...result };
  } catch (err) {
    emit({ t: "sync_error", repoId, reason, message: err.message });
    return { error: err.message };
  }
}

// ── the PR / branch watcher ──────────────────────────────────────────────────

/**
 * One cheap poll: has the branch moved, or has a PR merged into it?
 *
 * Uses the GitHub API when a token is available (it also gives us the open PR
 * list for the dashboard), and falls back to `git ls-remote` when it is not, so
 * a repo added by SSH with no account still gets watched.
 */
async function checkForWork(repoId) {
  const repo = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);
  if (!repo) return { gone: true };

  db.prepare(`UPDATE repos SET last_watch_at = datetime('now') WHERE id = ?`).run(repoId);

  const token = activeToken();
  const remote = git.parseRemote(repo.url);
  let remoteSha = null;
  let newlyMerged = [];

  if (token && remote.host === "github.com" && remote.owner && remote.name) {
    try {
      const head = await github.branchHead(token, remote.owner, remote.name, repo.default_branch);
      remoteSha = head.sha;

      const prs = await github.listPullRequests(token, remote.owner, remote.name, {
        base: repo.default_branch,
      });
      newlyMerged = recordPullRequests(repoId, prs);
    } catch (err) {
      emit({ t: "watch_error", repoId, message: err.message });
    }
  }

  if (!remoteSha) {
    // No API access — ask git directly. Still one network round trip, no clone.
    const creds = { url: repo.url, auth_type: repo.auth_type, credential_ref: repo.credential_ref };
    const dir = git.workdirFor(repoId, repo.url);
    if (git.isCloned(dir)) {
      await git.fetchBranch(dir, creds, repo.default_branch).catch(() => {});
      remoteSha = await git.remoteHead(dir, creds, repo.default_branch).catch(() => null);
    }
  }

  const moved = Boolean(remoteSha && remoteSha !== repo.last_indexed_sha);
  emit({
    t: "watch_tick",
    repoId,
    moved,
    remoteSha,
    mergedPrs: newlyMerged.map((p) => p.number),
  });

  if (!moved && newlyMerged.length === 0) return { moved: false, mergedPrs: [] };

  const reason = newlyMerged.length
    ? `pull request #${newlyMerged.map((p) => p.number).join(", #")} merged`
    : "default branch moved";
  const result = await syncRepo(repoId, reason);

  if (!result.error && !result.blocked && newlyMerged.length) {
    const mark = db.prepare(`UPDATE pull_requests SET ingested = 1 WHERE repo_id = ? AND number = ?`);
    for (const pr of newlyMerged) mark.run(repoId, pr.number);
  }

  return { moved, mergedPrs: newlyMerged.map((p) => p.number), result };
}

/** Store the PR list and return the ones that merged since we last looked. */
function recordPullRequests(repoId, prs) {
  const upsert = db.prepare(
    `INSERT INTO pull_requests
       (repo_id, number, title, author, state, base_branch, head_branch, merge_sha, url, updated_at, merged_at)
     VALUES (@repo_id, @number, @title, @author, @state, @base_branch, @head_branch, @merge_sha, @url, @updated_at, @merged_at)
     ON CONFLICT(repo_id, number) DO UPDATE SET
       title = excluded.title, state = excluded.state, merge_sha = excluded.merge_sha,
       updated_at = excluded.updated_at, merged_at = excluded.merged_at`,
  );
  const known = db.prepare(`SELECT state, ingested FROM pull_requests WHERE repo_id = ? AND number = ?`);

  const newlyMerged = [];
  db.transaction(() => {
    for (const pr of prs) {
      const before = known.get(repoId, pr.number);
      upsert.run({
        repo_id: repoId,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        state: pr.state,
        base_branch: pr.baseBranch,
        head_branch: pr.headBranch,
        merge_sha: pr.mergeSha,
        url: pr.url,
        updated_at: pr.updatedAt,
        merged_at: pr.mergedAt,
      });
      // Merged, and we have not already pulled it in.
      if (pr.state === "merged" && (!before || before.state !== "merged" || !before.ingested)) {
        newlyMerged.push(pr);
      }
    }
  })();

  return newlyMerged;
}

// ── scheduling ───────────────────────────────────────────────────────────────

function unschedule(repoId) {
  const task = cronTasks.get(repoId);
  if (task) {
    task.stop();
    cronTasks.delete(repoId);
  }
  const watcher = watchers.get(repoId);
  if (watcher) {
    clearInterval(watcher);
    watchers.delete(repoId);
  }
}

/** (Re)create both clocks for one repo from its stored settings. */
function scheduleRepo(repoId) {
  unschedule(repoId);
  const repo = db
    .prepare(
      `SELECT id, name, schedule_cron, schedule_tz, watch_prs, watch_interval_min FROM repos WHERE id = ?`,
    )
    .get(repoId);
  if (!repo) return;

  const expr = repo.schedule_cron || config.defaults.scheduleCron;
  if (expr !== "off") {
    if (!cron.validate(expr)) {
      emit({ t: "schedule_error", repoId, message: `invalid cron "${expr}"` });
    } else {
      const tz = repo.schedule_tz && isValidTimezone(repo.schedule_tz) ? repo.schedule_tz : undefined;
      cronTasks.set(
        repoId,
        cron.schedule(expr, () => {
          syncRepo(repoId, `scheduled (${expr})`).catch(() => {});
        }, tz ? { timezone: tz } : undefined),
      );
    }
  }

  if (repo.watch_prs) {
    const minutes = Math.max(5, repo.watch_interval_min || config.defaults.watchIntervalMin);
    watchers.set(
      repoId,
      setInterval(() => {
        checkForWork(repoId).catch(() => {});
      }, minutes * 60_000),
    );
  }

  emit({
    t: "schedule_set",
    repoId,
    cron: expr,
    tz: repo.schedule_tz || null,
    watchMinutes: repo.watch_prs ? repo.watch_interval_min : null,
  });
}

function startScheduler() {
  db.prepare(`UPDATE repos SET schedule_cron = ? WHERE schedule_cron IS NULL`).run(
    config.defaults.scheduleCron,
  );
  for (const r of db.prepare(`SELECT id FROM repos`).all()) scheduleRepo(r.id);
}

function stopScheduler() {
  for (const id of [...cronTasks.keys(), ...watchers.keys()]) unschedule(id);
}

function describe() {
  return db
    .prepare(
      `SELECT id, name, schedule_cron, schedule_tz, watch_prs, watch_interval_min, last_watch_at,
              last_indexed_at, status
       FROM repos ORDER BY name`,
    )
    .all()
    .map((r) => ({
      repoId: r.id,
      name: r.name,
      cron: r.schedule_cron,
      timezone: r.schedule_tz,
      watching: Boolean(r.watch_prs),
      watchMinutes: r.watch_interval_min,
      lastWatchAt: r.last_watch_at,
      lastIndexedAt: r.last_indexed_at,
      status: r.status,
      cronActive: cronTasks.has(r.id),
      watcherActive: watchers.has(r.id),
    }));
}

module.exports = {
  syncRepo,
  checkForWork,
  scheduleRepo,
  unschedule,
  startScheduler,
  stopScheduler,
  describe,
  isValidCron,
  isValidTimezone,
};
