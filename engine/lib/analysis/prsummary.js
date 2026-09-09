"use strict";

// "What landed."
//
// A merge notification that says `Merge pull request #482 from feat/retry` tells
// a developer nothing. This reads every commit on the branch and the diff they
// produced, and writes the thing a person actually wants at 9am: what changed,
// what is new, what got fixed, what might break, and which two or three files
// are worth opening.
//
// Written for humans, in plain language. The knowledge graph is where the
// machine-readable detail lives.

const { db, json: parseJson } = require("../db");
const { emit, progress } = require("../events");
const providers = require("../providers");
const github = require("../github");
const git = require("../git");

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "headline", "overview", "features", "fixes", "refactors",
    "breaking", "reviewFiles", "risk", "riskReason",
  ],
  properties: {
    headline: { type: "string" },
    overview: { type: "string" },
    features: { type: "array", items: { type: "string" } },
    fixes: { type: "array", items: { type: "string" } },
    refactors: { type: "array", items: { type: "string" } },
    breaking: { type: "array", items: { type: "string" } },
    reviewFiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "why"],
        properties: { path: { type: "string" }, why: { type: "string" } },
      },
    },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    riskReason: { type: "string" },
  },
};

const SYSTEM = `Summarise one merged pull request for the team that has to live with it.

Write for a developer reading a morning digest — plain language, no jargon for its own sake, no
restating commit subjects. Describe what is now TRUE of the codebase that was not true before.

- headline: one line, under 90 characters, what this change is. No ticket numbers, no "feat:".
- overview: 2-4 sentences a developer can read without opening the diff. Say what changed and why
  it matters. If the branch did several unrelated things, say so.
- features: capabilities that did not exist before. Empty array if none.
- fixes: bugs fixed. Name the actual wrong behaviour and what it does now. Empty array if none.
- refactors: restructuring with no behaviour change. Empty array if none.
- breaking: anything that changes an existing contract — a renamed endpoint, a changed payload
  field, a new required environment variable, a dropped export, a migration. Empty array if none.
  Be strict about this: a wrong empty array here is the most expensive mistake you can make.
- reviewFiles: the 2-5 files a reviewer should actually open, each with one line on why that file
  and not the others. Use exact paths from the diff. Prefer files where logic changed over files
  with large mechanical diffs.
- risk: low when it is additive or isolated; medium when it touches shared code paths; high when
  it changes data, auth, money, migrations, or deployment.
- riskReason: one sentence naming the specific thing that makes it that risk.

Base every statement on the diff you are shown. If the diff is truncated, say what you can support
and do not speculate about the rest.`;

/** Trim a patch to the parts that carry meaning, so the budget goes on real code. */
function condensePatch(patch, budget) {
  if (patch.length <= budget) return patch;

  const files = patch.split(/^diff --git /m).filter(Boolean);
  const noise = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)|\.svg|\.snap|dist\/|build\/)/;

  // Lock files and build output are almost never why a change matters, but they
  // are almost always the biggest hunks in it.
  const ranked = files
    .map((body) => ({ body, boring: noise.test(body.slice(0, 200)) }))
    .sort((a, b) => Number(a.boring) - Number(b.boring));

  let out = "";
  for (const file of ranked) {
    if (out.length + file.body.length > budget) {
      out += `\ndiff --git ${file.body.slice(0, Math.max(0, budget - out.length))}\n… diff truncated …\n`;
      break;
    }
    out += `diff --git ${file.body}`;
  }
  return out;
}

/**
 * Gather everything known about one merge, from GitHub when a token is
 * available and from the local clone otherwise. A repository added by SSH with
 * no account still gets a summary; it just has no PR title to work from.
 */
async function gather(repoId, repo, merge) {
  const creds = { url: repo.url, auth_type: repo.auth_type, credential_ref: repo.credential_ref };
  const dir = git.workdirFor(repoId, repo.url);

  const commits = await git.commitsInMerge(dir, creds, merge.sha).catch(() => []);
  const files = await git.filesInMerge(dir, creds, merge.sha).catch(() => []);
  const patch = await git.patchForMerge(dir, creds, merge.sha).catch(() => "");

  let prBody = null;
  if (merge.number) {
    const token = require("../repos").accountToken();
    const remote = git.parseRemote(repo.url);
    if (token && remote.owner && remote.name) {
      prBody = await github
        .pullRequestBody(token, remote.owner, remote.name, merge.number)
        .catch(() => null);
    }
  }

  return { commits, files, patch, prBody, dir };
}

/**
 * Summarise one merge and store it.
 *
 * Idempotent by sha: re-running over a merge that already has a summary returns
 * the stored one rather than paying for it twice.
 */
async function summarizeMerge(repoId, merge, opts = {}) {
  const existing = db
    .prepare(`SELECT * FROM pr_summaries WHERE repo_id = ? AND sha = ?`)
    .get(repoId, merge.sha);
  if (existing && !opts.force) return shape(existing);

  const repo = db.prepare(`SELECT * FROM repos WHERE id = ?`).get(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);

  const cfg = providers.resolveProvider(repo.provider_id);
  const { commits, files, patch, prBody } = await gather(repoId, repo, merge);

  if (commits.length === 0 && files.length === 0) {
    return null; // nothing to describe
  }

  progress("pr", `Summarising ${merge.number ? `#${merge.number}` : merge.sha.slice(0, 8)}`, { repoId });

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  const result = await providers.askJson(cfg, {
    system: SYSTEM,
    user: `Repository: ${repo.name}, branch ${repo.default_branch}
${merge.number ? `Pull request #${merge.number}: ${merge.title || "(no title)"}` : `Merge commit ${merge.sha.slice(0, 10)}`}
Author: ${merge.author || commits[0]?.author || "unknown"}
${prBody ? `\nDescription the author wrote:\n${prBody.slice(0, 2000)}\n` : ""}
Commits on the branch (${commits.length}):
${commits.map((c) => `- ${c.shortSha} ${c.subject}${c.body ? `\n    ${c.body.split("\n").slice(0, 3).join(" ")}` : ""}`).join("\n") || "(none listed)"}

Files changed (${files.length}, +${additions} / -${deletions}):
${files.map((f) => `- ${f.path} +${f.additions}/-${f.deletions}`).join("\n")}

Diff:
${condensePatch(patch, 45_000)}`,
    schema: SUMMARY_SCHEMA,
    effort: "high",
  });

  const row = {
    repo_id: repoId,
    number: merge.number ?? null,
    sha: merge.sha,
    title: merge.title ?? commits[0]?.subject ?? null,
    author: merge.author ?? commits[0]?.author ?? null,
    url: merge.url ?? null,
    merged_at: merge.mergedAt ?? commits[0]?.date ?? null,
    headline: result.headline || "Changes landed",
    overview: result.overview || "",
    features: JSON.stringify(result.features || []),
    fixes: JSON.stringify(result.fixes || []),
    refactors: JSON.stringify(result.refactors || []),
    breaking: JSON.stringify(result.breaking || []),
    review_files: JSON.stringify(result.reviewFiles || []),
    risk: result.risk || "low",
    risk_reason: result.riskReason || "",
    commit_count: commits.length,
    files_changed: files.length,
    additions,
    deletions,
  };

  db.prepare(
    `INSERT INTO pr_summaries
       (repo_id, number, sha, title, author, url, merged_at, headline, overview, features, fixes,
        refactors, breaking, review_files, risk, risk_reason, commit_count, files_changed,
        additions, deletions)
     VALUES (@repo_id, @number, @sha, @title, @author, @url, @merged_at, @headline, @overview,
             @features, @fixes, @refactors, @breaking, @review_files, @risk, @risk_reason,
             @commit_count, @files_changed, @additions, @deletions)
     ON CONFLICT(repo_id, sha) DO UPDATE SET
       headline = excluded.headline, overview = excluded.overview, features = excluded.features,
       fixes = excluded.fixes, refactors = excluded.refactors, breaking = excluded.breaking,
       review_files = excluded.review_files, risk = excluded.risk, risk_reason = excluded.risk_reason,
       commit_count = excluded.commit_count, files_changed = excluded.files_changed,
       additions = excluded.additions, deletions = excluded.deletions`,
  ).run(row);

  emit({
    t: "pr_summarized",
    repoId,
    number: merge.number ?? null,
    sha: merge.sha,
    headline: row.headline,
    risk: row.risk,
    breaking: (result.breaking || []).length,
  });

  return shape(db.prepare(`SELECT * FROM pr_summaries WHERE repo_id = ? AND sha = ?`).get(repoId, merge.sha));
}

/**
 * Summarise every merge that landed in this sync and has not been described yet.
 * Bounded, because a first index of an old repository would otherwise try to
 * summarise years of history in one go.
 */
async function summarizeNewMerges(repoId, commits, opts = {}) {
  const limit = opts.limit ?? 10;
  const known = new Set(
    db.prepare(`SELECT sha FROM pr_summaries WHERE repo_id = ?`).all(repoId).map((r) => r.sha),
  );

  const pending = commits
    .filter((c) => !known.has(c.sha))
    .slice(0, limit)
    .map((c) => ({
      sha: c.sha,
      number: c.prNumber ? Number(c.prNumber) : null,
      title: c.subject,
      author: c.author,
      mergedAt: c.date,
    }));

  const written = [];
  for (const merge of pending) {
    try {
      const summary = await summarizeMerge(repoId, merge);
      if (summary) written.push(summary);
    } catch (err) {
      emit({ t: "pr_summary_error", repoId, sha: merge.sha, message: err.message });
    }
  }
  return written;
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    sha: row.sha,
    shortSha: (row.sha || "").slice(0, 8),
    title: row.title,
    author: row.author,
    url: row.url,
    mergedAt: row.merged_at,
    headline: row.headline,
    overview: row.overview,
    features: parseJson(row.features, []),
    fixes: parseJson(row.fixes, []),
    refactors: parseJson(row.refactors, []),
    breaking: parseJson(row.breaking, []),
    reviewFiles: parseJson(row.review_files, []),
    risk: row.risk,
    riskReason: row.risk_reason,
    commitCount: row.commit_count,
    filesChanged: row.files_changed,
    additions: row.additions,
    deletions: row.deletions,
    createdAt: row.created_at,
  };
}

function listSummaries(repoId, limit = 40) {
  return db
    .prepare(
      `SELECT * FROM pr_summaries WHERE repo_id = ?
       ORDER BY COALESCE(merged_at, created_at) DESC LIMIT ?`,
    )
    .all(repoId, limit)
    .map(shape);
}

module.exports = { summarizeMerge, summarizeNewMerges, listSummaries };
