"use strict";

const fs = require("node:fs");
const path = require("node:path");
const simpleGit = require("simple-git").default || require("simple-git");
const { config } = require("./config");
const secrets = require("./secrets");

const UNIT = "\x1f";
const REC = "\x1e";

// ── addressing ───────────────────────────────────────────────────────────────

function repoSlug(url) {
  const cleaned = String(url).replace(/\.git$/, "").replace(/^git@([^:]+):/, "$1/");
  const parts = cleaned.split(/[/:]/).filter(Boolean).slice(-2);
  return parts.join("__").replace(/[^A-Za-z0-9_.-]/g, "-");
}

function repoName(url) {
  return String(url).replace(/\.git$/, "").split(/[/:]/).filter(Boolean).slice(-1)[0] || "repo";
}

/** Splits any git URL into { host, owner, name }. Handles ssh, https and scp-style. */
function parseRemote(url) {
  const raw = String(url).trim().replace(/\.git$/, "");
  let host = "github.com";
  let rest = raw;

  const scp = raw.match(/^(?:ssh:\/\/)?(?:[^@]+@)?([^/:]+)[:/](.+)$/);
  const http = raw.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/);
  if (http) {
    host = http[1];
    rest = http[2];
  } else if (scp && !raw.startsWith("/") && !raw.startsWith(".")) {
    host = scp[1];
    rest = scp[2];
  } else {
    // A local path. Owner is its parent directory.
    const parts = raw.split("/").filter(Boolean);
    return { host: "local", owner: parts.slice(-2, -1)[0] || "", name: parts.slice(-1)[0] || "repo" };
  }

  const seg = rest.split("/").filter(Boolean);
  return { host, owner: seg.slice(0, -1).join("/"), name: seg.slice(-1)[0] || "repo" };
}

function workdirFor(repoId, url) {
  return path.join(config.workspaceDir, `${repoId}-${repoSlug(url)}`);
}

// ── credentials ──────────────────────────────────────────────────────────────

/**
 * The URL actually handed to git. For HTTPS the token goes in the userinfo
 * position at call time only — origin in .git/config stays the clean URL, so a
 * token never lands on disk.
 */
function authedUrl(creds) {
  if (creds.auth_type !== "token" || !creds.credential_ref) return creds.url;
  const token = secrets.require(creds.credential_ref, "The git credential for this repository");
  const u = new URL(creds.url);
  u.username = encodeURIComponent(token);
  u.password = "x-oauth-basic";
  return u.toString();
}

function gitEnv(creds) {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // simple-git refuses to run when an editor or pager override is inherited from
  // the shell — and git already skips the pager when stdout is not a TTY, which
  // it never is here.
  for (const k of ["GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "VISUAL", "PAGER", "GIT_PAGER", "LESS"]) {
    delete e[k];
  }
  if (creds.auth_type === "ssh") {
    const key = creds.credential_ref ? secrets.get(creds.credential_ref) : null;
    if (key) {
      e.GIT_SSH_COMMAND = `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    }
  }
  return e;
}

function git(dir, creds) {
  return simpleGit({ baseDir: dir, maxConcurrentProcesses: 1 }).env(gitEnv(creds));
}

// ── remote inspection (before anything is cloned) ────────────────────────────

async function listBranches(creds) {
  const out = await simpleGit()
    .env(gitEnv(creds))
    .raw(["ls-remote", "--symref", "--heads", authedUrl(creds)]);
  const branches = [];
  let head = null;
  for (const line of out.split("\n")) {
    const sym = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
    if (sym) {
      head = sym[1];
      continue;
    }
    const b = line.split("refs/heads/")[1];
    if (b) branches.push(b.trim());
  }
  return { branches, head: head || pickDefault(branches) };
}

/** Falls back to convention when the remote does not publish a symref HEAD. */
function pickDefault(branches) {
  for (const candidate of ["main", "master", "develop", "development", "trunk"]) {
    if (branches.includes(candidate)) return candidate;
  }
  return branches[0] || "main";
}

// ── clone / fetch ────────────────────────────────────────────────────────────

function isCloned(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

async function cloneRepo(repoId, creds, branch, onProgress) {
  const dir = workdirFor(repoId, creds.url);
  if (isCloned(dir)) return dir;
  fs.mkdirSync(dir, { recursive: true });

  const url = authedUrl(creds);
  const client = simpleGit({ baseDir: config.workspaceDir })
    .env(gitEnv(creds))
    .outputHandler((_cmd, stdout, stderr) => {
      if (!onProgress) return;
      stderr.on("data", (d) => onProgress(String(d)));
    });

  // A full clone (no blob filter): later fetches go through origin, which we
  // deliberately keep secret-free, so lazy blob fetching would fail on private repos.
  await client.clone(url, dir, ["--no-tags", "--single-branch", "--branch", branch, "--progress"]);
  await git(dir, creds).remote(["set-url", "origin", creds.url]);
  return dir;
}

/** Always fetch before anything reads the remote branch. Never merges. */
async function fetchBranch(dir, creds, branch) {
  const url = authedUrl(creds);
  await git(dir, creds).raw([
    "fetch",
    url,
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    "--prune",
  ]);
}

async function remoteHead(dir, creds, branch) {
  return (await git(dir, creds).raw(["rev-parse", `refs/remotes/origin/${branch}`])).trim();
}

async function localHead(dir, creds) {
  return (await git(dir, creds).raw(["rev-parse", "HEAD"])).trim().slice(0, 40);
}

/** Commits on origin/<branch> that the working tree does not have yet. */
async function behindCount(dir, creds, branch) {
  const out = await git(dir, creds)
    .raw(["rev-list", "--count", `HEAD..refs/remotes/origin/${branch}`])
    .catch(() => "0");
  return Number(out.trim()) || 0;
}

async function aheadCount(dir, creds, branch) {
  const out = await git(dir, creds)
    .raw(["rev-list", "--count", `refs/remotes/origin/${branch}..HEAD`])
    .catch(() => "0");
  return Number(out.trim()) || 0;
}

/**
 * Is this working tree safe to blow away?
 *
 * "Clean" here means the app put every byte in it: no uncommitted edits, no
 * untracked files, no commits of the user's own. That is the normal state for a
 * deploy mirror, and the only state in which `reset --hard` can lose nothing.
 */
async function worktreeState(dir, creds, branch) {
  const g = git(dir, creds);
  const porcelain = await g.raw(["status", "--porcelain=v1", "--untracked-files=normal"]);
  const dirtyFiles = porcelain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2).trim(), path: l.slice(3) }));

  const ahead = await aheadCount(dir, creds, branch);
  const behind = await behindCount(dir, creds, branch);
  const currentBranch = (await g.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  return {
    branch: currentBranch,
    dirtyFiles,
    dirty: dirtyFiles.length > 0,
    ahead,
    behind,
    clean: dirtyFiles.length === 0 && ahead === 0,
  };
}

// ── pulling ──────────────────────────────────────────────────────────────────

/**
 * Bring the working tree to origin/<branch>.
 *
 *  reset  — discard everything local and match the remote exactly. No conflict
 *           is possible. This is the default because a deploy mirror holds
 *           nothing of the user's.
 *  merge  — a real merge, so local commits survive. May stop on conflict, in
 *           which case the conflicted paths come back for the caller to resolve.
 *
 * Either way the caller has already fetched: this never touches the network.
 */
async function applyUpdate(dir, creds, branch, strategy) {
  const g = git(dir, creds);
  const target = `refs/remotes/origin/${branch}`;

  if (strategy === "reset") {
    await g.raw(["checkout", "-f", "-B", branch, target]);
    await g.raw(["reset", "--hard", target]);
    await g.raw(["clean", "-fd"]);
    return { ok: true, strategy: "reset", conflicts: [] };
  }

  await g.raw(["checkout", "-B", branch]).catch(() => {});

  // Whether the merge "failed" is decided by looking at the index, not by
  // whether the git wrapper raised. A conflicted merge exits non-zero, but a
  // library that swallows or remaps that would have us report a clean pull over
  // a working tree full of conflict markers — and then redeploy it.
  let mergeError = null;
  try {
    await g.raw(["merge", "--no-edit", target]);
  } catch (err) {
    mergeError = err;
  }

  const conflicts = await conflictedPaths(dir, creds);
  if (conflicts.length > 0) return { ok: false, strategy: "merge", conflicts };

  if (mergeError) {
    // Non-zero for some other reason — an unrelated local change in the way, a
    // hook refusing. Leave the tree as git left it and report verbatim.
    throw new Error(mergeError.message);
  }
  return { ok: true, strategy: "merge", conflicts: [] };
}

async function conflictedPaths(dir, creds) {
  const out = await git(dir, creds).raw(["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** The three sides of one conflicted file, for a human or a model to reconcile. */
async function conflictSides(dir, creds, filePath) {
  const g = git(dir, creds);
  const read = async (stage) =>
    g.raw(["show", `:${stage}:${filePath}`]).catch(() => "");
  return {
    path: filePath,
    base: await read(1),
    ours: await read(2),
    theirs: await read(3),
    merged: fs.existsSync(path.join(dir, filePath))
      ? fs.readFileSync(path.join(dir, filePath), "utf8")
      : "",
  };
}

async function stageResolved(dir, creds, filePath, contents) {
  fs.writeFileSync(path.join(dir, filePath), contents, "utf8");
  await git(dir, creds).raw(["add", "--", filePath]);
}

async function commitMerge(dir, creds, message) {
  await git(dir, creds).raw(["commit", "--no-edit", "-m", message]);
}

async function abortMerge(dir, creds) {
  await git(dir, creds).raw(["merge", "--abort"]).catch(() => {});
}

async function stashAll(dir, creds, label) {
  await git(dir, creds).raw(["stash", "push", "--include-untracked", "-m", label]);
}

// ── history ──────────────────────────────────────────────────────────────────

/**
 * Merge commits on the branch's first-parent line — what PR merges actually
 * landed. Falls back to plain first-parent commits for repos that squash- or
 * rebase-merge.
 *
 * One streaming `git log` with inline --numstat, not a diff per commit: a repo
 * with a few thousand merges would otherwise mean a few thousand git processes.
 */
async function listMergeCommits(dir, creds, branch, opts = {}) {
  const g = git(dir, creds);
  const limit = opts.limit ?? 0;
  const range = opts.sinceSha
    ? `${opts.sinceSha}..refs/remotes/origin/${branch}`
    : `refs/remotes/origin/${branch}`;
  const fmt = REC + ["%H", "%h", "%an", "%ae", "%aI", "%s", "%P"].join(UNIT);

  const run = async (mergesOnly) => {
    const args = ["log", "--first-parent", "-m", "--numstat", "--no-renames", `--pretty=format:${fmt}`, range];
    if (mergesOnly) args.splice(1, 0, "--merges");
    if (limit > 0) args.splice(1, 0, `--max-count=${limit}`);
    return g.raw(args).catch(() => "");
  };

  let raw = await run(true);
  let mergesOnly = true;
  if (raw.trim() === "") {
    raw = await run(false);
    mergesOnly = false;
  }

  const commits = [];
  for (const record of raw.split(REC)) {
    if (!record.trim()) continue;
    const nl = record.indexOf("\n");
    const header = nl === -1 ? record : record.slice(0, nl);
    const body = nl === -1 ? "" : record.slice(nl + 1);
    const [sha, shortSha, author, email, date, subject, parents] = header.split(UNIT);
    if (!sha) continue;
    if (commits.length && commits[commits.length - 1].sha === sha) continue;

    const parentList = (parents || "").split(" ").filter(Boolean);
    commits.push({
      sha,
      shortSha,
      author,
      email,
      date,
      subject,
      isMerge: mergesOnly && parentList.length > 1,
      prNumber:
        (subject && subject.match(/(?:pull request|merge request|PR|MR)\s*[#!](\d+)/i)?.[1]) ||
        (subject && subject.match(/\(#(\d+)\)\s*$/)?.[1]) ||
        null,
      files: parseNumstat(body),
    });
  }
  return commits;
}

function parseNumstat(out) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 3)
    .map(([a, d, p]) => ({
      additions: a === "-" ? 0 : Number(a) || 0, // "-" means binary
      deletions: d === "-" ? 0 : Number(d) || 0,
      path: p.includes("=>")
        ? p.replace(/.*\{(.*) => (.*)\}.*/, (_m, _o, n) => n).replace(/^.*=> /, "").replace(/[{}]/g, "")
        : p,
    }));
}

/**
 * The individual commits a merge brought in.
 *
 * For a merge commit that is `sha^1..sha^2` — everything on the branch that was
 * not already on the target. For a squash or a plain commit there is no second
 * parent, so the commit itself is the whole story. This is what turns "one merge
 * landed" into "here are the six things the author actually did".
 */
async function commitsInMerge(dir, creds, sha) {
  const g = git(dir, creds);
  const fmt = REC + ["%H", "%h", "%an", "%aI", "%s", "%b"].join(UNIT);

  const parents = (await g.raw(["rev-list", "--parents", "-n", "1", sha]).catch(() => "")).trim().split(/\s+/);
  const range = parents.length >= 3 ? `${parents[1]}..${parents[2]}` : `${sha}^..${sha}`;

  const raw = await g
    .raw(["log", `--pretty=format:${fmt}`, "--no-merges", range])
    .catch(() => "");

  const commits = [];
  for (const record of raw.split(REC)) {
    if (!record.trim()) continue;
    const [full, short, author, date, subject, body] = record.split(UNIT);
    if (!full) continue;
    commits.push({
      sha: full.trim(),
      shortSha: short,
      author,
      date,
      subject,
      body: (body || "").trim().slice(0, 800),
    });
  }
  return commits;
}

/** Per-file added/removed counts for one commit or merge. */
async function filesInMerge(dir, creds, sha) {
  const out = await git(dir, creds)
    .raw(["show", "--numstat", "--format=", "--first-parent", "-m", sha])
    .catch(() => "");
  return parseNumstat(out);
}

/**
 * The patch a merge introduced, capped.
 *
 * A summary written from commit subjects alone repeats the commit subjects. The
 * diff is what lets it say "the retry now backs off exponentially" instead of
 * "fixed retries".
 */
async function patchForMerge(dir, creds, sha, maxChars = 60_000) {
  const g = git(dir, creds);
  const parents = (await g.raw(["rev-list", "--parents", "-n", "1", sha]).catch(() => "")).trim().split(/\s+/);
  const args = parents.length >= 3
    ? ["diff", "--no-color", "--unified=3", `${parents[1]}...${parents[2]}`]
    : ["show", "--no-color", "--unified=3", "--format=", sha];
  const out = await g.raw(args).catch(() => "");
  return out.slice(0, maxChars);
}

/** The unified diff a range introduced — fed to the model for "what changed". */
async function diffStat(dir, creds, fromSha, toSha) {
  const g = git(dir, creds);
  const out = await g
    .raw(["diff", "--stat", "--no-color", `${fromSha}..${toSha}`])
    .catch(() => "");
  return out.trim();
}

async function showCommitPatch(dir, creds, sha, maxChars = 40_000) {
  const out = await git(dir, creds)
    .raw(["show", "--no-color", "--stat", "--patch", "--first-parent", "-m", sha])
    .catch(() => "");
  return out.slice(0, maxChars);
}

module.exports = {
  repoSlug,
  repoName,
  parseRemote,
  workdirFor,
  isCloned,
  listBranches,
  pickDefault,
  cloneRepo,
  fetchBranch,
  remoteHead,
  localHead,
  behindCount,
  aheadCount,
  worktreeState,
  applyUpdate,
  conflictedPaths,
  conflictSides,
  stageResolved,
  commitMerge,
  abortMerge,
  stashAll,
  listMergeCommits,
  commitsInMerge,
  filesInMerge,
  patchForMerge,
  diffStat,
  showCommitPatch,
};
