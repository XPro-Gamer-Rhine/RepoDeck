"use strict";

// Daemon mode: one long-lived engine process the RepoDeck app drives over
// JSON-RPC (see rpc.js). Everything the UI can do is a method here.
//
// The app starts exactly one of these at launch and keeps it for the session,
// so a scheduled sync can run while you read a graph, and the PR watchers stay
// alive without the app having to own a timer per repository.

const { serve } = require("./rpc");
const { emit } = require("./events");
const { db, getSetting, setSetting } = require("./db");
const secrets = require("./secrets");
const github = require("./github");
const git = require("./git");
const repos = require("./repos");
const providers = require("./providers");
const graph = require("./graph");
const { indexRepo, isRunning, applyUpdateOrStop } = require("./pipeline/ingest");
const conflict = require("./pipeline/conflict");
const deploy = require("./pipeline/deploy");
const scheduler = require("./pipeline/scheduler");
const knowledge = require("./analysis/knowledge");
const prsummary = require("./analysis/prsummary");
const exporter = require("./analysis/export");

function runDaemon() {
  const methods = {
    // ── lifecycle ────────────────────────────────────────────────────────────

    "app.ping": async () => ({ pong: true, pid: process.pid }),

    /**
     * The app pushes Keychain values down after the pipe is live. Nothing that
     * needs a credential works before this lands, which is deliberate: a stolen
     * database file has no secrets in it.
     */
    "app.secrets": async ({ secrets: entries }) => {
      const result = secrets.setAll(entries);
      // Schedules can only start once tokens exist, so this is the natural moment.
      scheduler.startScheduler();
      emit({ t: "secrets_loaded", count: result.count });
      return result;
    },

    "app.state": async () => ({
      account: repos.activeAccount(),
      providers: providers.listProviders(),
      repos: repos.listRepos(),
      schedules: scheduler.describe(),
      settings: {
        githubClientId: getSetting("github_client_id", ""),
      },
    }),

    "app.setting": async ({ key, value }) => {
      setSetting(key, value);
      return { key, value };
    },

    "app.shutdown": async () => {
      scheduler.stopScheduler();
      await deploy.stopAll();
      secrets.clear();
      setTimeout(() => process.exit(0), 150);
      return { ok: true };
    },

    // ── GitHub sign-in ───────────────────────────────────────────────────────

    "github.cliToken": async () => ({ token: await github.cliToken() }),

    "github.deviceStart": async ({ clientId, scope }) =>
      github.deviceStart(clientId || getSetting("github_client_id", ""), scope),

    "github.devicePoll": async ({ clientId, deviceCode }) =>
      github.devicePoll(clientId || getSetting("github_client_id", ""), deviceCode),

    /** Verify a token the app has already put in the Keychain, and remember who it belongs to. */
    "github.connect": async ({ tokenRef }) => repos.saveAccount(tokenRef),

    "github.signOut": async () => repos.signOut(),

    "github.repos": async ({ page }) => {
      const token = repos.accountToken();
      if (!token) throw new Error("Sign in to GitHub first.");
      return { repos: await github.listRepos(token, { page: page || 1 }) };
    },

    // ── AI providers ─────────────────────────────────────────────────────────

    "ai.list": async () => ({ providers: providers.listProviders() }),
    "ai.save": async (input) => repos.saveProvider(input),
    "ai.delete": async ({ id }) => repos.deleteProvider(id),
    "ai.test": async ({ id }) => {
      const row = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id);
      if (!row) throw new Error("No such provider.");
      return providers.ping(row);
    },

    // ── repositories ─────────────────────────────────────────────────────────

    "repo.inspect": async (params) => repos.inspectRemote(params),
    "repo.list": async () => ({ repos: repos.listRepos() }),
    "repo.get": async ({ repoId }) => repos.getRepo(repoId),
    "repo.add": async (input) => {
      const created = repos.addRepo(input);
      scheduler.scheduleRepo(created.repoId);
      return created;
    },
    "repo.update": async ({ repoId, ...patch }) => {
      const updated = repos.updateRepo(repoId, patch);
      scheduler.scheduleRepo(repoId); // cron / watch settings may have moved
      return updated;
    },
    "repo.remove": async ({ repoId, deleteFiles }) => {
      scheduler.unschedule(repoId);
      await deploy.stop(repoId).catch(() => {});
      return repos.removeRepo(repoId, { deleteFiles });
    },
    "repo.refreshBranch": async ({ repoId }) => repos.refreshDefaultBranch(repoId),

    /** Clone and run the first full index. This is what "Add repository" ends in. */
    "repo.setup": async ({ repoId }) => indexRepo(repoId, { full: true }),

    "repo.index": async ({ repoId, full, knowledge: kg }) =>
      indexRepo(repoId, { full: Boolean(full), knowledge: kg !== false }),

    /** Fetch, then update the tree — nothing else. Returns conflicts rather than resolving them. */
    "repo.pull": async ({ repoId, strategy }) => {
      const repo = require("./pipeline/ingest").getRepo(repoId);
      const creds = require("./pipeline/ingest").creds(repo);
      const dir = git.workdirFor(repoId, repo.url);
      if (!git.isCloned(dir)) throw new Error("This repository has not been cloned yet.");

      await git.fetchBranch(dir, creds, repo.default_branch); // always fetch first
      const before = await git.localHead(dir, creds);
      const result = await applyUpdateOrStop(
        repoId,
        dir,
        creds,
        repo.default_branch,
        strategy || repo.pull_strategy,
      );
      const after = await git.localHead(dir, creds).catch(() => before);

      db.prepare(`UPDATE repos SET last_pulled_at = datetime('now') WHERE id = ?`).run(repoId);
      return { ...result, from: before, to: after, changed: before !== after };
    },

    "repo.status": async ({ repoId }) => {
      const repo = require("./pipeline/ingest").getRepo(repoId);
      const creds = require("./pipeline/ingest").creds(repo);
      const dir = git.workdirFor(repoId, repo.url);
      if (!git.isCloned(dir)) return { cloned: false };
      await git.fetchBranch(dir, creds, repo.default_branch).catch(() => {});
      const state = await git.worktreeState(dir, creds, repo.default_branch);
      return { cloned: true, indexing: isRunning(repoId), ...state };
    },

    "repo.jobs": async ({ repoId, limit }) => ({ jobs: repos.listJobs(repoId, limit) }),

    // ── merge conflicts ──────────────────────────────────────────────────────

    "conflict.preview": async ({ repoId }) => conflict.preview(repoId),
    "conflict.apply": async ({ repoId, resolutions, message, partial }) =>
      conflict.apply(repoId, resolutions || [], { message, partial }),
    "conflict.takeSide": async ({ repoId, side }) => conflict.takeSide(repoId, side),
    "conflict.stashAndReset": async ({ repoId }) => conflict.stashAndReset(repoId),
    "conflict.abort": async ({ repoId }) => conflict.abort(repoId),

    // ── graph ────────────────────────────────────────────────────────────────

    "graph.get": async ({ repoId, nodes, hideTests, minHeat }) =>
      graph.getGraph(repoId, {
        nodes,
        hideTests: hideTests !== false,
        minHeat: minHeat || 0,
      }),
    "graph.hotspots": async ({ repoId, limit }) => ({ files: graph.hotspots(repoId, limit || 50) }),
    "graph.file": async ({ repoId, path }) => graph.fileDetail(repoId, path),
    "graph.symbol": async ({ repoId, path, name }) => graph.symbolDetail(repoId, path, name),

    /**
     * Rebuild only the call graph. Purely static, so it costs nothing and takes
     * a second — worth having separately from a full re-index, which spends
     * model calls on things the call graph does not need.
     */
    "graph.rebuildSymbols": async ({ repoId }) => {
      const { getRepo } = require("./pipeline/ingest");
      const { buildSymbolGraph } = require("./pipeline/ingest");
      const { scanRepo } = require("./analysis/scan");
      const { buildResolverConfig, resolveSpecifier } = require("./analysis/resolve");

      const repo = getRepo(repoId);
      const dir = git.workdirFor(repoId, repo.url);
      const scanned = scanRepo(dir);
      const known = new Set(scanned.map((f) => f.path));
      const cfg = buildResolverConfig(dir);
      const resolved = new Map(
        scanned.map((f) => [
          f.path,
          f.imports
            .map((spec) => resolveSpecifier(f.path, spec, known, cfg))
            .filter(Boolean)
            .map((r) => r.target),
        ]),
      );
      return buildSymbolGraph(repoId, scanned, resolved);
    },
    "graph.commits": async ({ repoId, limit }) => ({ commits: graph.commits(repoId, limit || 60) }),
    "graph.activity": async ({ repoId, weeks }) => ({ weeks: graph.activity(repoId, weeks || 26) }),

    // ── knowledge graph ──────────────────────────────────────────────────────

    "kg.get": async ({ repoId }) => knowledge.readKnowledgeGraph(repoId),

    "kg.build": async ({ repoId }) => {
      // A standalone rebuild re-runs the scan so the graph describes the tree as
      // it is now, not as it was when the last index ran.
      const repo = require("./pipeline/ingest").getRepo(repoId);
      const { scanRepo, readManifests } = require("./analysis/scan");
      const { buildResolverConfig, resolveSpecifier } = require("./analysis/resolve");
      const dir = git.workdirFor(repoId, repo.url);
      const scanned = scanRepo(dir);
      const manifests = readManifests(dir);

      const known = new Set(scanned.map((f) => f.path));
      const cfg = buildResolverConfig(dir);
      const resolvedImports = new Map(
        scanned.map((f) => [
          f.path,
          f.imports
            .map((spec) => resolveSpecifier(f.path, spec, known, cfg))
            .filter(Boolean)
            .map((r) => r.target),
        ]),
      );

      const taxonomy = db
        .prepare(
          `SELECT DISTINCT module AS name FROM files
           WHERE repo_id = ? AND deleted = 0 AND module IS NOT NULL AND module != ''`,
        )
        .all(repoId)
        .map((r) => ({ name: r.name, description: "" }));

      return knowledge.buildKnowledgeGraph(repoId, {
        provider: providers.resolveProvider(repo.provider_id),
        scanned,
        manifests,
        resolvedImports,
        taxonomy,
      });
    },

    "kg.export": async ({ repoId, dest, agents }) => exporter.exportBundle(repoId, { dest, agents }),

    "kg.claudeMd": async ({ repoId }) => ({
      markdown: exporter.renderClaudeMd(knowledge.readKnowledgeGraph(repoId)),
    }),

    // ── local deploy ─────────────────────────────────────────────────────────

    "deploy.detect": async ({ repoId }) => deploy.detectProfile(repoId),
    "deploy.save": async ({ repoId, profile }) => deploy.saveProfile(repoId, profile),
    "deploy.start": async ({ repoId, install }) => deploy.start(repoId, { install, restart: true }),
    "deploy.stop": async ({ repoId }) => deploy.stop(repoId),
    "deploy.status": async ({ repoId }) => deploy.status(repoId),
    "deploy.logs": async ({ repoId, tail }) => ({ lines: deploy.logs(repoId, tail || 400) }),

    // ── scheduling and watching ──────────────────────────────────────────────

    "sched.list": async () => ({ schedules: scheduler.describe() }),
    "sched.set": async ({ repoId, cron, timezone, watchPrs, watchIntervalMin }) => {
      if (cron && cron !== "off" && !scheduler.isValidCron(cron)) {
        throw new Error(`"${cron}" is not a valid cron expression.`);
      }
      if (timezone && !scheduler.isValidTimezone(timezone)) {
        throw new Error(`"${timezone}" is not a time zone this Mac knows about.`);
      }
      repos.updateRepo(repoId, { cron, timezone, watchPrs, watchIntervalMin });
      scheduler.scheduleRepo(repoId);
      return { ok: true };
    },
    "sched.runNow": async ({ repoId }) => scheduler.syncRepo(repoId, "manual"),
    "sched.checkNow": async ({ repoId }) => scheduler.checkForWork(repoId),

    "prs.list": async ({ repoId }) => ({ pullRequests: repos.listPullRequests(repoId) }),

    /** Plain-language digests of what each merge actually did. */
    "prs.summaries": async ({ repoId, limit }) => ({
      summaries: prsummary.listSummaries(repoId, limit || 40),
    }),

    "prs.summarize": async ({ repoId, sha, number, title, author, url, force }) =>
      prsummary.summarizeMerge(repoId, { sha, number, title, author, url }, { force }),

    /** Describe every indexed merge that has no digest yet. */
    "prs.backfill": async ({ repoId, limit }) => {
      const merges = db
        .prepare(
          `SELECT sha, short_sha, author, message AS subject, committed_at AS date, pr_number
           FROM commits WHERE repo_id = ? ORDER BY committed_at DESC LIMIT ?`,
        )
        .all(repoId, limit || 10)
        .map((c) => ({ ...c, prNumber: c.pr_number }));
      const written = await prsummary.summarizeNewMerges(repoId, merges, { limit: limit || 10 });
      return { written: written.length, summaries: written };
    },
  };

  // Nothing gets left running when the app quits or the pipe closes.
  const shutdown = () => {
    scheduler.stopScheduler();
    deploy.stopAll().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  serve(methods);
  return new Promise(() => {}); // resolves only via process exit
}

module.exports = { runDaemon };
