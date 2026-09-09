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

/** repoId -> the conflict signature a human has already been asked about. */
const awaitingReview = new Map();

/** repoId -> true while a watcher tick is in flight, so ticks cannot overlap. */
const watching = new Set();

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
  // These carry `changed: false` explicitly. Callers used to test
  // `result.changed !== false`, and a skip returning no `changed` key at all
  // passed that test — so a watcher tick that collided with a running sync
  // marked its pull requests ingested and they were never summarised.
  if (!repo) return { skipped: "gone", changed: false };
  if (isRunning(repoId)) return { skipped: "already running", changed: false };

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
      // Once a conflict has been put in front of a person, re-running the model
      // on every tick spends money to produce the same answer and re-notifies
      // about the same thing. Try once, then leave it alone until the tree changes.
      const signature = result.conflicts.slice().sort().join("|");
      if (awaitingReview.get(repoId) === signature) {
        emit({ t: "sync_blocked", repoId, conflicts: result.conflicts, reason: "already awaiting review" });
        return { blocked: true, conflicts: result.conflicts };
      }

      progress("sync", "Resolving merge conflicts", { repoId });
      let resolved;
      try {
        resolved = await conflict.autoResolve(repoId);
      } catch (err) {
        // The point of this map is "a model pass has already been spent on this
        // exact conflict", which is just as true when the pass ended in an
        // exception. Without this the same conflict was re-analysed at high
        // effort on every tick, indefinitely, against a paid API.
        awaitingReview.set(repoId, signature);
        throw err;
      }
      if (resolved.blocked) awaitingReview.set(repoId, signature);
      if (resolved.blocked) {
        emit({ t: "sync_blocked", repoId, conflicts: result.conflicts, reason: "needs review" });
        return { blocked: true, conflicts: result.conflicts, resolutions: resolved.resolutions };
      }
      // The tree is clean now — index the merge we just made.
      return syncRepo(repoId, `${reason} (after conflict resolution)`);
    }

    awaitingReview.delete(repoId);

    if (result.cancelled) {
      // The repository was removed while it was being indexed. Nothing landed,
      // and reporting a successful sync for a row that no longer exists left the
      // UI showing a phantom result.
      emit({ t: "sync_done", repoId, reason, changed: false, cancelled: true });
      return { changed: false, cancelled: true };
    }

    if (result.upToDate) {
      emit({ t: "sync_done", repoId, reason, changed: false });
      return { changed: false };
    }

    // Redeploy only when the app is meant to be running and something landed.
    const fresh = db
      .prepare(`SELECT auto_deploy, deploy_enabled, deploy_state FROM repos WHERE id = ?`)
      .get(repoId);
    // "failed" is worth restarting; "stopped" means a person stopped it, and an
    // unattended sync quietly starting it again is the app overriding a decision
    // the user made on purpose.
    const wasDeliberatelyStopped = fresh && fresh.deploy_state === "stopped";
    if (fresh && fresh.auto_deploy && fresh.deploy_enabled && !wasDeliberatelyStopped) {
      // Only the files this sync actually brought in. The previous query asked
      // for thirty days of history, so "did a lock file change?" was answered
      // about the last month rather than about this merge — and dependencies
      // were reinstalled on almost every deploy.
      const changed = db
        .prepare(
          `SELECT DISTINCT fc.path AS path
           FROM file_changes fc
           JOIN commits c ON c.id = fc.commit_id
           WHERE fc.repo_id = ?
             AND (? = '' OR c.committed_at > (
                   SELECT committed_at FROM commits WHERE repo_id = ? AND sha = ?
                 ))`,
        )
        .all(repoId, result.previousSha || "", repoId, result.previousSha || "")
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

  // An index in flight owns this working tree. The watcher's fallback path runs
  // `git fetch` on that same directory, which moves refs/remotes/origin/<branch>
  // underneath it — the index then records a last_indexed_sha for commits it
  // never scanned, and those commits are never indexed by anything.
  if (isRunning(repoId)) return { skipped: "indexing", moved: false, mergedPrs: [] };

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

  // `changed === false` means the sync was a no-op — the repository was gone, or
  // another run held the lock. Marking the PR ingested then loses it forever.
  // A positive signal, not the absence of a negative one.
  if (result.changed === true && !result.error && !result.blocked && newlyMerged.length) {
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
  awaitingReview.delete(repoId);
  // `watching` is NOT cleared here. It marks a checkForWork that is still in
  // flight, and unschedule cannot cancel that — clearing the flag let the next
  // schedule's first tick start a second concurrent run on the same repository,
  // and its `finally` then deleted the flag the first run was still relying on.
  // The tick's own `finally` is the only thing that should clear it.
  const task = cronTasks.get(repoId);
  if (task) {
    task.stop();
    // node-cron keeps every scheduled task in a module-global registry and
    // stop() only clears the timer, so rescheduling a repo leaked one entry per
    // change — measured: three schedule/stop cycles leave three live tasks.
    try {
      const name = task.options && task.options.name;
      if (name && typeof cron.getTasks === "function") cron.getTasks().delete(name);
    } catch {
      /* a leaked registry entry is not worth failing a reschedule over */
    }
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
        // A tick that overruns its interval would otherwise stack up behind
        // itself; on a slow network that is several concurrent GitHub polls.
        if (watching.has(repoId)) return;
        watching.add(repoId);
        checkForWork(repoId)
          .catch(() => {})
          .finally(() => watching.delete(repoId));
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
