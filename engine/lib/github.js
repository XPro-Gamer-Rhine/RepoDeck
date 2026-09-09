"use strict";

// GitHub access, three ways — all of them ending in a token the app puts in the
// Keychain and hands back as a ref:
//
//   1. `gh auth token` — if the GitHub CLI is already signed in, this is one
//      click and no new credentials exist anywhere.
//   2. OAuth device flow — the user enters a code on github.com. Needs a public
//      OAuth App client id, which the user supplies once in settings; there is
//      no client secret in the device flow, so nothing sensitive ships in the app.
//   3. A personal access token pasted in.
//
// Every call here takes a plain token string. Resolving a Keychain ref to a
// token is the caller's job, so this module never touches the vault.

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const API = "https://api.github.com";
const UA = "RepoDeck";

async function gh(token, pathname, opts = {}) {
  const res = await fetch(pathname.startsWith("http") ? pathname : `${API}${pathname}`, {
    method: opts.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401) throw new Error("GitHub rejected the token (401). Sign in again.");
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
    throw new Error(`GitHub rate limit reached. Resets ${new Date(reset).toLocaleTimeString()}.`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }

  return {
    body: res.status === 204 ? null : await res.json(),
    scopes: (res.headers.get("x-oauth-scopes") || "").split(",").map((s) => s.trim()).filter(Boolean),
    link: res.headers.get("link") || "",
  };
}

// ── 1. the GitHub CLI's token ────────────────────────────────────────────────

async function cliToken() {
  for (const bin of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"]) {
    try {
      const { stdout } = await execFileAsync(bin, ["auth", "token"], { timeout: 5000 });
      const token = stdout.trim();
      if (token) return token;
    } catch {
      // try the next path
    }
  }
  throw new Error(
    "The GitHub CLI isn't signed in on this Mac. Run `gh auth login`, or use device sign-in / a token instead.",
  );
}

// ── 2. device flow ───────────────────────────────────────────────────────────

const DEFAULT_SCOPES = "repo read:org read:user";

async function deviceStart(clientId, scope = DEFAULT_SCOPES) {
  if (!clientId) throw new Error("No OAuth client id set. Add one in Settings → GitHub.");
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error_description || body.error);
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    interval: body.interval || 5,
    expiresIn: body.expires_in || 900,
  };
}

/**
 * One poll. The app calls this on the interval GitHub asked for and shows the
 * user code meanwhile; `pending` means keep going, `slowDown` means back off.
 */
async function devicePoll(clientId, deviceCode) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const body = await res.json();

  if (body.access_token) return { token: body.access_token };
  if (body.error === "authorization_pending") return { pending: true };
  if (body.error === "slow_down") return { pending: true, slowDown: true, interval: body.interval };
  if (body.error === "expired_token") throw new Error("The sign-in code expired. Start again.");
  if (body.error === "access_denied") throw new Error("Sign-in was denied on github.com.");
  throw new Error(body.error_description || body.error || "Device sign-in failed.");
}

// ── identity and repositories ────────────────────────────────────────────────

async function whoami(token) {
  const { body, scopes } = await gh(token, "/user");
  return {
    login: body.login,
    name: body.name,
    avatarUrl: body.avatar_url,
    scopes,
    canReadPrivate: scopes.includes("repo"),
  };
}

/** Repositories the token can see, newest activity first. */
async function listRepos(token, { page = 1, perPage = 100 } = {}) {
  const { body } = await gh(
    token,
    `/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
  );
  return body.map(shapeRepo);
}

async function getRepo(token, owner, name) {
  const { body } = await gh(token, `/repos/${owner}/${name}`);
  return shapeRepo(body);
}

function shapeRepo(r) {
  return {
    fullName: r.full_name,
    owner: r.owner && r.owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch,
    sshUrl: r.ssh_url,
    httpsUrl: r.clone_url,
    description: r.description,
    language: r.language,
    pushedAt: r.pushed_at,
    stars: r.stargazers_count,
  };
}

// ── pull requests ────────────────────────────────────────────────────────────

/** Open PRs targeting `base`, plus PRs merged since `since` (an ISO string). */
async function listPullRequests(token, owner, name, { base, since } = {}) {
  const q = new URLSearchParams({ state: "all", per_page: "50", sort: "updated", direction: "desc" });
  if (base) q.set("base", base);
  const { body } = await gh(token, `/repos/${owner}/${name}/pulls?${q}`);

  return body
    .filter((pr) => !since || !pr.updated_at || pr.updated_at > since)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user && pr.user.login,
      state: pr.merged_at ? "merged" : pr.state,
      baseBranch: pr.base && pr.base.ref,
      headBranch: pr.head && pr.head.ref,
      mergeSha: pr.merge_commit_sha,
      url: pr.html_url,
      updatedAt: pr.updated_at,
      mergedAt: pr.merged_at,
    }));
}

/** The description the author wrote on a pull request, which often says the "why". */
async function pullRequestBody(token, owner, name, number) {
  const { body } = await gh(token, `/repos/${owner}/${name}/pulls/${number}`);
  return body.body || null;
}

/** Every commit on a pull request's branch, straight from the API. */
async function pullRequestCommits(token, owner, name, number) {
  const { body } = await gh(token, `/repos/${owner}/${name}/pulls/${number}/commits?per_page=100`);
  return body.map((c) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 8),
    author: (c.author && c.author.login) || (c.commit.author && c.commit.author.name),
    date: c.commit.author && c.commit.author.date,
    subject: (c.commit.message || "").split("\n")[0],
    body: (c.commit.message || "").split("\n").slice(1).join("\n").trim(),
  }));
}

/** The remote branch tip, without cloning. Cheapest possible "is there new work". */
async function branchHead(token, owner, name, branch) {
  const { body } = await gh(token, `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`);
  return { sha: body.commit && body.commit.sha, protectedBranch: body.protected };
}

async function listBranchNames(token, owner, name) {
  const { body } = await gh(token, `/repos/${owner}/${name}/branches?per_page=100`);
  return body.map((b) => b.name);
}

module.exports = {
  cliToken,
  deviceStart,
  devicePoll,
  whoami,
  listRepos,
  getRepo,
  listPullRequests,
  pullRequestBody,
  pullRequestCommits,
  branchHead,
  listBranchNames,
  DEFAULT_SCOPES,
};
