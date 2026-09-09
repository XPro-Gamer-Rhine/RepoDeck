"use strict";

// Running the app locally, and keeping it running on the latest code.
//
// Detection proposes a run profile; nothing executes until the profile has been
// saved, which the UI only does after the user has seen the exact commands.
// From then on a redeploy is: stop the old process group, reinstall if the lock
// file moved, start again, and wait for the health check.
//
// Processes are started in their own process group via a login shell, so a
// Node/Python/Ruby toolchain installed through nvm/pyenv/rbenv is on PATH, and
// stopping kills the whole tree rather than orphaning children.

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { db, json: parseJson, startJob, finishJob } = require("../db");
const { config } = require("../config");
const { emit, progress } = require("../events");
const git = require("../git");
const { readJson } = require("../analysis/resolve");

/** repoId -> { child, profile, logPath, buffer, startedAt } */
const supervised = new Map();

// ── detection ────────────────────────────────────────────────────────────────

function exists(dir, ...names) {
  return names.find((n) => fs.existsSync(path.join(dir, n))) || null;
}

function nodeInstallCommand(dir) {
  if (exists(dir, "pnpm-lock.yaml")) return "pnpm install --frozen-lockfile";
  if (exists(dir, "yarn.lock")) return "yarn install --frozen-lockfile";
  if (exists(dir, "bun.lockb")) return "bun install";
  if (exists(dir, "package-lock.json")) return "npm ci";
  return "npm install";
}

function nodeRunner(dir) {
  if (exists(dir, "pnpm-lock.yaml")) return "pnpm";
  if (exists(dir, "yarn.lock")) return "yarn";
  if (exists(dir, "bun.lockb")) return "bun";
  return "npm run";
}

/** Ports mentioned in a compose file or a script, so the health check has something to poll. */
function guessPort(dir, text) {
  const fromEnv = () => {
    for (const name of [".env", ".env.example", ".env.local"]) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      const m = fs.readFileSync(file, "utf8").match(/^\s*(?:PORT|APP_PORT|SERVER_PORT)\s*=\s*(\d{2,5})/m);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const inText = String(text || "").match(/(?:--port[= ]|:)(\d{4,5})\b/);
  return (inText && Number(inText[1])) || fromEnv() || null;
}

/**
 * Work out how this repository is meant to be run.
 *
 * Returns a proposal, plus every other candidate found, so the UI can offer the
 * alternatives instead of making the user retype a command it already knows.
 */
function detectProfile(repoId) {
  const repo = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  const dir = git.workdirFor(repoId, repo.url);
  if (!fs.existsSync(dir)) throw new Error("This repository has not been cloned yet.");

  const candidates = [];

  const compose = exists(dir, "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml");
  if (compose) {
    const body = fs.readFileSync(path.join(dir, compose), "utf8");
    candidates.push({
      kind: "compose",
      label: `Docker Compose (${compose})`,
      install: "",
      run: "docker compose up --build",
      stop: "docker compose down",
      port: guessPort(dir, body),
      detectedFrom: compose,
    });
  }

  const pkg = readJson(path.join(dir, "package.json"));
  if (pkg && pkg.scripts) {
    const runner = nodeRunner(dir);
    for (const script of ["dev", "start", "serve", "develop", "start:dev"]) {
      if (!pkg.scripts[script]) continue;
      candidates.push({
        kind: "node",
        label: `${runner} ${script}`,
        install: nodeInstallCommand(dir),
        run: `${runner} ${script}`,
        stop: "",
        port: guessPort(dir, pkg.scripts[script]),
        detectedFrom: "package.json",
      });
    }
  }

  const procfile = exists(dir, "Procfile", "Procfile.dev");
  if (procfile) {
    const body = fs.readFileSync(path.join(dir, procfile), "utf8");
    const web = body.split("\n").find((l) => /^web\s*:/.test(l));
    if (web) {
      candidates.push({
        kind: "procfile",
        label: `Procfile web process`,
        install: "",
        run: web.replace(/^web\s*:\s*/, ""),
        stop: "",
        port: guessPort(dir, web),
        detectedFrom: procfile,
      });
    }
  }

  if (exists(dir, "manage.py")) {
    candidates.push({
      kind: "django",
      label: "Django development server",
      install: exists(dir, "requirements.txt") ? "pip install -r requirements.txt" : "",
      run: "python manage.py runserver 0.0.0.0:8000",
      stop: "",
      port: 8000,
      detectedFrom: "manage.py",
    });
  }

  if (exists(dir, "artisan")) {
    candidates.push({
      kind: "laravel",
      label: "Laravel development server",
      install: "composer install --no-interaction",
      run: "php artisan serve --host=0.0.0.0 --port=8000",
      stop: "",
      port: 8000,
      detectedFrom: "artisan",
    });
  }

  const makefile = exists(dir, "Makefile", "makefile");
  if (makefile) {
    const body = fs.readFileSync(path.join(dir, makefile), "utf8");
    const target = ["dev", "run", "start", "serve"].find((t) => new RegExp(`^${t}\\s*:`, "m").test(body));
    if (target) {
      candidates.push({
        kind: "make",
        label: `make ${target}`,
        install: /^install\s*:/m.test(body) ? "make install" : "",
        run: `make ${target}`,
        stop: "",
        port: guessPort(dir, body),
        detectedFrom: makefile,
      });
    }
  }

  if (exists(dir, "go.mod")) {
    candidates.push({
      kind: "go",
      label: "go run .",
      install: "go mod download",
      run: "go run .",
      stop: "",
      port: guessPort(dir, ""),
      detectedFrom: "go.mod",
    });
  }

  if (exists(dir, "Cargo.toml")) {
    candidates.push({
      kind: "cargo",
      label: "cargo run",
      install: "cargo fetch",
      run: "cargo run",
      stop: "",
      port: guessPort(dir, ""),
      detectedFrom: "Cargo.toml",
    });
  }

  const envFile = exists(dir, ".env") || null;
  const envExample = exists(dir, ".env.example", ".env.sample") || null;

  const proposed = candidates[0] || {
    kind: "custom",
    label: "No run command detected",
    install: "",
    run: "",
    stop: "",
    port: null,
    detectedFrom: null,
  };

  const profile = {
    ...proposed,
    cwd: ".",
    envFile,
    envExample,
    // Missing .env when the repo ships an example is the single most common
    // reason a first local run fails, so it is surfaced, not discovered later.
    envMissing: Boolean(envExample && !envFile),
    healthUrl: proposed.port ? `http://localhost:${proposed.port}` : "",
    healthTimeoutSec: 120,
  };

  return { profile, candidates, dir };
}

function saveProfile(repoId, profile) {
  db.prepare(`UPDATE repos SET deploy_profile = ?, deploy_enabled = 1 WHERE id = ?`).run(
    JSON.stringify(profile),
    repoId,
  );
  return getProfile(repoId);
}

function getProfile(repoId) {
  const row = db.prepare(`SELECT deploy_profile FROM repos WHERE id = ?`).get(repoId);
  return row ? parseJson(row.deploy_profile, null) : null;
}

// ── log capture ──────────────────────────────────────────────────────────────

function logPathFor(repoId) {
  return path.join(config.logDir, `repo-${repoId}.log`);
}

function pushLog(entry, stream, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    entry.buffer.push({ stream, text: line, at: Date.now() });
    if (entry.buffer.length > config.limits.logTailLines) entry.buffer.shift();
    emit({ t: "deploy_log", repoId: entry.repoId, stream, text: line });
  }
  fs.appendFile(entry.logPath, text, () => {});
}

// ── health ───────────────────────────────────────────────────────────────────

function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function waitForHealth(profile, entry) {
  if (!profile.port && !profile.healthUrl) return { healthy: null, reason: "no health check configured" };
  const deadline = Date.now() + (profile.healthTimeoutSec || 120) * 1000;

  while (Date.now() < deadline) {
    if (!entry.child || entry.child.exitCode !== null) {
      return { healthy: false, reason: "the process exited before it became healthy" };
    }
    if (profile.port && (await portOpen(profile.port))) return { healthy: true };
    if (!profile.port && profile.healthUrl) {
      const ok = await fetch(profile.healthUrl, { method: "GET" }).then(
        (r) => r.status < 500,
        () => false,
      );
      if (ok) return { healthy: true };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { healthy: false, reason: "health check timed out" };
}

// ── lifecycle ────────────────────────────────────────────────────────────────

function setState(repoId, state, extra = {}) {
  db.prepare(`UPDATE repos SET deploy_state = ?, deploy_pid = ?, deploy_started_at = ? WHERE id = ?`).run(
    state,
    extra.pid ?? null,
    extra.startedAt ?? null,
    repoId,
  );
  emit({ t: "deploy_state", repoId, state, ...extra });
}

/** One shell command, run to completion, output streamed. Used for installs. */
function runOnce(command, cwd, entry) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-lc", command], { cwd, env: { ...process.env, CI: "1" } });
    child.stdout.on("data", (d) => pushLog(entry, "stdout", d.toString()));
    child.stderr.on("data", (d) => pushLog(entry, "stderr", d.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`\`${command}\` exited with code ${code}`)),
    );
  });
}

async function start(repoId, opts = {}) {
  if (supervised.has(repoId)) {
    if (!opts.restart) return status(repoId);
    await stop(repoId);
  }

  const repo = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);
  const profile = getProfile(repoId);
  if (!profile || !profile.run) {
    throw new Error("No run command is configured for this repository. Set one in the Deploy tab.");
  }

  const dir = path.resolve(git.workdirFor(repoId, repo.url), profile.cwd || ".");
  const jobId = startJob(repoId, "deploy");
  const entry = {
    repoId,
    profile,
    logPath: logPathFor(repoId),
    buffer: [],
    startedAt: Date.now(),
    child: null,
  };
  supervised.set(repoId, entry);
  fs.writeFileSync(entry.logPath, `\n=== ${new Date().toISOString()} — starting ${repo.name} ===\n`);

  try {
    setState(repoId, "starting");

    if (profile.envMissing) {
      pushLog(entry, "stderr", `[RepoDeck] ${profile.envExample} exists but .env does not — the app may fail to start.\n`);
    }

    if (opts.install !== false && profile.install) {
      progress("deploy", `Installing dependencies: ${profile.install}`, { repoId });
      await runOnce(profile.install, dir, entry);
    }

    progress("deploy", `Starting: ${profile.run}`, { repoId });
    const child = spawn("/bin/zsh", ["-lc", profile.run], {
      cwd: dir,
      // Its own process group, so stopping takes the whole tree with it.
      detached: true,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    entry.child = child;

    child.stdout.on("data", (d) => pushLog(entry, "stdout", d.toString()));
    child.stderr.on("data", (d) => pushLog(entry, "stderr", d.toString()));
    child.on("exit", (code, signal) => {
      pushLog(entry, "stderr", `\n[RepoDeck] process exited (code ${code}, signal ${signal || "none"})\n`);
      supervised.delete(repoId);
      // A clean stop already set the state; only an unexpected exit is a failure.
      const current = db.prepare(`SELECT deploy_state FROM repos WHERE id = ?`).get(repoId);
      if (current && current.deploy_state !== "stopped") setState(repoId, "failed");
    });

    setState(repoId, "starting", { pid: child.pid, startedAt: new Date().toISOString() });

    const health = await waitForHealth(profile, entry);
    if (health.healthy === false) {
      finishJob(jobId, "error", health.reason);
      setState(repoId, "failed", { pid: child.pid });
      return { ok: false, ...health, pid: child.pid, logTail: entry.buffer.slice(-40) };
    }

    setState(repoId, "running", { pid: child.pid, startedAt: new Date(entry.startedAt).toISOString() });
    finishJob(jobId, "ok", `running as pid ${child.pid}${profile.port ? ` on port ${profile.port}` : ""}`);
    return { ok: true, pid: child.pid, port: profile.port || null, healthy: health.healthy };
  } catch (err) {
    finishJob(jobId, "error", err.message);
    setState(repoId, "failed");
    supervised.delete(repoId);
    throw err;
  }
}

async function stop(repoId) {
  const entry = supervised.get(repoId);
  setState(repoId, "stopped");
  if (!entry || !entry.child) return { stopped: false };

  const pid = entry.child.pid;
  supervised.delete(repoId);

  // Negative pid = the whole process group, so a `npm run dev` that forked a
  // bundler and a server takes both with it.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      entry.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  await new Promise((r) => setTimeout(r, 2500));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* exited on SIGTERM, as it should have */
  }

  if (entry.profile && entry.profile.stop) {
    const dir = path.resolve(git.workdirFor(repoId, db.prepare(`SELECT url FROM repos WHERE id = ?`).get(repoId).url));
    await runOnce(entry.profile.stop, dir, entry).catch(() => {});
  }

  return { stopped: true, pid };
}

/**
 * Restart on new code. Dependencies are reinstalled only when a lock file
 * actually moved in the incoming commits — reinstalling on every merge would
 * turn a two-second restart into a two-minute one.
 */
async function redeploy(repoId, changedPaths = []) {
  const lockTouched = changedPaths.some((p) =>
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|poetry\.lock|Gemfile\.lock|Cargo\.lock|go\.sum|requirements\.txt)$/.test(p),
  );
  emit({ t: "redeploy", repoId, install: lockTouched, changed: changedPaths.length });
  return start(repoId, { restart: true, install: lockTouched });
}

function status(repoId) {
  const row = db
    .prepare(`SELECT deploy_state, deploy_pid, deploy_started_at, deploy_enabled, auto_deploy FROM repos WHERE id = ?`)
    .get(repoId);
  const entry = supervised.get(repoId);
  return {
    state: row ? row.deploy_state : "stopped",
    pid: row ? row.deploy_pid : null,
    startedAt: row ? row.deploy_started_at : null,
    enabled: Boolean(row && row.deploy_enabled),
    autoDeploy: Boolean(row && row.auto_deploy),
    supervised: Boolean(entry),
    profile: getProfile(repoId),
  };
}

function logs(repoId, tail = 400) {
  const entry = supervised.get(repoId);
  if (entry) return entry.buffer.slice(-tail);
  try {
    return fs
      .readFileSync(logPathFor(repoId), "utf8")
      .split("\n")
      .slice(-tail)
      .map((text) => ({ stream: "stdout", text }));
  } catch {
    return [];
  }
}

/** Called when the engine is shutting down: never leave an orphaned server behind. */
async function stopAll() {
  await Promise.all([...supervised.keys()].map((id) => stop(id).catch(() => {})));
}

module.exports = { detectProfile, saveProfile, getProfile, start, stop, redeploy, status, logs, stopAll };
