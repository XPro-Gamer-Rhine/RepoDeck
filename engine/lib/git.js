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
 * The askpass helper.
 *
 * git needs the token, but a token passed as a git *argument* — which is what
 * embedding it in the URL does — is readable from the process table by anything
 * running as this user. That is not hypothetical for RepoDeck: it runs
 * `npm install` from cloned third-party repositories as the same user, so a
 * malicious postinstall script would only have to poll `ps` while a fetch was in
 * flight.
 *
 * So the URL carries a username only, and git asks this script for the password.
 * The token reaches it through the environment, which — unlike argv — one
 * process cannot read from another on macOS.
 */
const ASKPASS_PATH = path.join(config.root, "git-askpass.sh");

function ensureAskpass() {
  const script = '#!/bin/sh\n' +
    '# Written by RepoDeck. Hands git the credential for the current operation\n' +
    '# without it ever appearing in a command line.\n' +
    'printf %s "$REPODECK_GIT_PASSWORD"\n';
  try {
    // Rewrite only when it differs, so this is a stat on the common path.
    if (fs.readFileSync(ASKPASS_PATH, "utf8") === script) return ASKPASS_PATH;
  } catch {
    // Not there yet.
  }
  fs.writeFileSync(ASKPASS_PATH, script, { mode: 0o700 });
  fs.chmodSync(ASKPASS_PATH, 0o700);
  return ASKPASS_PATH;
}

/**
 * The URL handed to git.
 *
 * For token auth this carries the username `x-access-token` and no secret —
 * GitHub, GitLab and Bitbucket all accept a PAT as the password for that user.
 * The password itself travels via GIT_ASKPASS. `origin` in .git/config stays the
 * clean URL either way, so nothing lands on disk.
 */
function authedUrl(creds) {
  if (creds.auth_type !== "token" || !creds.credential_ref) return creds.url;
  if (!creds.url.startsWith("http")) return creds.url;
  const u = new URL(creds.url);
  u.username = "x-access-token";
  u.password = "";
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

  if (creds.auth_type === "token" && creds.credential_ref) {
    const token = secrets.require(creds.credential_ref, "The git credential for this repository");
    e.GIT_ASKPASS = ensureAskpass();
    e.REPODECK_GIT_PASSWORD = token;
    // Belt and braces: if anything still tries an interactive prompt, fail fast
    // rather than hang, and never fall back to a system credential store.
    e.GIT_CONFIG_NOSYSTEM = "1";
  }

  if (creds.auth_type === "ssh") {
    const key = creds.credential_ref ? secrets.get(creds.credential_ref) : null;
    if (key) {
      // The key is a path, not a secret, but quote it so a path with a space or
      // a shell metacharacter cannot change the command git runs.
      e.GIT_SSH_COMMAND =
        `ssh -i '${String(key).replace(/'/g, "'\\''")}' ` +
        `-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
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
  const porcelain = await g.raw([
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "-z",
  ]);
  // Porcelain v1 is fixed-width: two status characters, a space, then the path.
  // Trimming the line first shifts a single-character code (" M file.txt") left by
  // one, so slice(3) then ate the first letter of the filename. -z also keeps a
  // filename containing a newline in one piece and stops git quoting non-ASCII
  // names.
  //
  // One wrinkle: with -z a rename entry is TWO NUL-terminated fields, the new
  // path then the old one. The second has no status prefix, so it is skipped.
  const dirtyFiles = [];
  const records = porcelain.split("\0").filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4 || record[2] !== " ") continue; // the trailing half of a rename
    const code = record.slice(0, 2).trim();
    dirtyFiles.push({ code, path: record.slice(3) });
    if (code[0] === "R" || code[0] === "C") i++; // consume the original path
  }

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
    // `checkout -B` force-moves the branch to the target, so any commit on it
    // that origin does not have is gone. The caller checks the CHECKED-OUT
    // branch, which is not necessarily this one — a clone left on some other
    // branch would have had `branch` silently rewound. Check the branch we are
    // about to move, not the one that happens to be current.
    const unpushed = await g
      .raw(["rev-list", "--count", `${target}..refs/heads/${branch}`])
      .then((n) => Number(n.trim()) || 0)
      .catch(() => 0);
    if (unpushed > 0) {
      return {
        ok: false,
        strategy: "reset",
        conflicts: [],
        refused: `refusing to reset ${branch}: it has ${unpushed} commit(s) origin does not have`,
      };
    }
    await g.raw(["checkout", "-f", "-B", branch, target]);
    await g.raw(["reset", "--hard", target]);
    await g.raw(["clean", "-fd"]);
    return { ok: true, strategy: "reset", conflicts: [] };
  }

  // Start-point matters: a bare `checkout -B <branch>` resets the branch to the
  // CURRENT HEAD, which drops its commits when HEAD is somewhere else. Move onto
  // the branch without moving the branch.
  // The `--` matters. Without it, `git checkout develop` in a repository that
  // has a `develop/` DIRECTORY but no local `develop` BRANCH is a pathspec
  // checkout: it exits 0, throws away uncommitted work under that directory,
  // and leaves HEAD where it was — so the merge below lands on the wrong branch
  // and the whole thing is reported as a successful pull.
  await g.raw(["checkout", branch, "--"]).catch(async () => {
    // It may not exist locally yet; create it on the remote-tracking tip.
    await g.raw(["checkout", "-B", branch, target]);
  });

  // Verify rather than assume: every path above has a way to leave HEAD behind.
  const head = await g.raw(["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim(), () => "");
  if (head !== branch) {
    return {
      ok: false,
      strategy: "merge",
      conflicts: [],
      refused: `Could not switch to ${branch} — the working tree is on ${head || "an unknown ref"}.`,
    };
  }

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

/**
 * Paths git reports as conflicted.
 *
 * NUL-delimited and with quoting off. By default git C-quotes any path with a
 * non-ASCII byte in it — `café.js` comes back as the literal 12-character
 * string `"caf\303\251.js"`, quotes and all — and every consumer then works on
 * a string that is not a path: reading its stages fails, the mode check finds
 * nothing, and writing a resolution creates a junk file beside the real one.
 * Splitting on newlines is wrong for the same reason a filename may contain one.
 */
async function conflictedPaths(dir, creds) {
  const out = await git(dir, creds)
    .raw(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U", "-z"])
    .catch(() => "");
  return out.split("\0").filter(Boolean);
}

/**
 * Paths that were conflicted in this merge and have since been staged.
 *
 * Staging a resolution removes the path from the conflicted list, so a retry
 * after a partial failure cannot tell "already dealt with" apart from "never
 * conflicted at all". During a merge the paths git has staged are exactly the
 * ones that differ from MERGE_HEAD in the index but are no longer unmerged.
 */
async function resolvedPaths(dir, creds) {
  const g = git(dir, creds);
  const mergeHead = await g.raw(["rev-parse", "--verify", "MERGE_HEAD"]).then(
    (s) => s.trim(),
    () => null,
  );
  if (!mergeHead) return [];
  const unmerged = new Set(await conflictedPaths(dir, creds));
  const nulSplit = (s) => s.split("\0").filter(Boolean);
  const diffAgainst = (ref) =>
    g
      .raw(["-c", "core.quotePath=false", "diff", "--name-only", "--cached", "-z", ref])
      .then(nulSplit, () => []);

  // Against BOTH parents. A file the merge auto-merged cleanly differs from HEAD
  // too, so comparing with HEAD alone returned every merged file and widened the
  // caller's write allowlist far past the conflicted set. A path that differs
  // from both sides is one somebody wrote a resolution for.
  const [vsHead, vsMergeHead] = await Promise.all([diffAgainst("HEAD"), diffAgainst(mergeHead)]);
  const alsoVsMergeHead = new Set(vsMergeHead);
  return vsHead.filter((p) => alsoVsMergeHead.has(p) && !unmerged.has(p));
}

/**
 * The index mode of a conflicted path, as a string like "100644".
 *
 * Used to refuse anything that is not an ordinary file. A conflicted symlink
 * passes a "git says this path is conflicted" check and then makes the write
 * follow the link — landing the content wherever the link points, which can be
 * outside the repository entirely. Gitlinks (submodules) are equally not ours
 * to write.
 */
async function conflictModes(dir, creds, filePath) {
  // No .catch here: the caller treats an empty result as "refuse", so a genuine
  // error has to be distinguishable from "git knows of no stages for this path".
  const out = await git(dir, creds).raw([
    "-c",
    "core.quotePath=false",
    "ls-files",
    "-u",
    "-z",
    "--",
    filePath,
  ]);
  const modes = new Set();
  for (const record of out.split("\0")) {
    const m = record.match(/^(\d{6})\s/);
    if (m) modes.add(m[1]);
  }
  return [...modes];
}

/** The three sides of one conflicted file, for a human or a model to reconcile. */
async function conflictSides(dir, creds, filePath) {
  const g = git(dir, creds);
  // Distinguish "this stage is an empty file" from "this stage does not exist".
  // Both come back as "" otherwise, and a delete/modify conflict then looks like
  // a file whose content is empty.
  const read = async (stage) =>
    g.raw(["show", `:${stage}:${filePath}`]).then(
      (text) => ({ present: true, text }),
      () => ({ present: false, text: "" }),
    );
  const [base, ours, theirs] = await Promise.all([read(1), read(2), read(3)]);
  return {
    path: filePath,
    stages: { base: base.present, ours: ours.present, theirs: theirs.present },
    base: base.text,
    ours: ours.text,
    theirs: theirs.text,
    merged: fs.existsSync(path.join(dir, filePath))
      ? fs.readFileSync(path.join(dir, filePath), "utf8")
      : "",
  };
}

async function stageResolved(dir, creds, filePath, contents) {
  // path.join happily walks out of the directory with enough "..", so resolve
  // and check containment before writing. The caller validates too; this is the
  // check that has to hold even if a future caller forgets.
  const root = path.resolve(dir);
  const target = path.resolve(root, filePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Refusing to write outside the repository: ${filePath}`);
  }

  // Containment is not enough on its own. If the path is a symlink, writing
  // through it puts the content wherever it points — which may be outside the
  // repository, and the containment check above would never have seen it.
  let existing = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    /* a new file is fine */
  }
  if (existing && !existing.isFile()) {
    throw new Error(
      `Refusing to write ${filePath}: it is a ${existing.isSymbolicLink() ? "symlink" : "special file"}, not a regular file.`,
    );
  }

  fs.writeFileSync(target, contents, "utf8");
  await git(dir, creds).raw(["add", "--", filePath]);
  // Re-materialise through git so eol and clean/smudge filters apply. Without
  // this a repository with `* text=auto` ends up with a working tree whose line
  // endings differ from a fresh checkout, and the very next status is dirty.
  await git(dir, creds).raw(["checkout", "--", filePath]).catch(() => {});
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
      // git writes a rename as `src/{old => new}/file.js` or `old => new`. The
      // first form has a prefix and a suffix outside the braces; replacing the
      // whole line with the brace contents dropped both, yielding a path that
      // does not exist in the repository.
      path: p.includes("=>")
        ? p
            .replace(/^(.*)\{(.*) => (.*)\}(.*)$/, (_m, pre, _old, next, post) => `${pre}${next}${post}`)
            .replace(/^.* => /, "")
            .replace(/\/{2,}/g, "/")
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
    // --no-renames, to match listMergeCommits. With detection on, git emits the
    // `{old => new}` form and the two callers disagreed about what a path is.
    .raw(["show", "--numstat", "--no-renames", "--format=", "--first-parent", "-m", sha])
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
async function patchForMerge(dir, creds, sha, maxChars = 400_000) {
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
  resolvedPaths,
  conflictModes,
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
