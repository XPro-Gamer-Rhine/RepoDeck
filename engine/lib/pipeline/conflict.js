"use strict";

// Merge conflict resolution.
//
// This only ever runs when a pull could not be applied cleanly, which on a
// deploy mirror means the working tree has work of the user's own in it. That
// makes every path here destructive-adjacent, so the design is: propose first,
// write second, and never silently.
//
//   preview()  reads the three sides of every conflicted file and asks the model
//              for a merged result plus its reasoning and a confidence — nothing
//              is written to disk.
//   apply()    writes the resolutions the caller approved, stages and commits.
//   abort()    puts the tree back the way git found it.
//
// A repo with `ai_conflict_fix` on lets the scheduler call apply() straight
// after preview() for high-confidence resolutions, so unattended redeploys keep
// working; anything less than confident still waits for a person.

const { db, startJob, finishJob } = require("../db");
const { emit, progress } = require("../events");
const git = require("../git");
const providers = require("../providers");
const { getRepo, creds } = require("./ingest");

/** Beyond this, a whole-file rewrite is the wrong tool and we say so. */
const MAX_SIDE_CHARS = 60_000;

const RESOLUTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["merged", "rationale", "confidence", "keptFromOurs", "keptFromTheirs", "concerns"],
  properties: {
    merged: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    keptFromOurs: { type: "array", items: { type: "string" } },
    keptFromTheirs: { type: "array", items: { type: "string" } },
    concerns: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = `You are resolving a git merge conflict in a real codebase.

You get three versions of one file: the common ancestor (base), the local version (ours) and the
incoming version from the remote branch (theirs). Produce the merged file.

Rules, in order of importance:
1. Output the COMPLETE file. Not a diff, not a fragment, not a description — the exact bytes that
   should be on disk.
2. Never leave conflict markers (<<<<<<<, =======, >>>>>>>) in the output.
3. Keep BOTH sides' intent wherever they touch different concerns. A conflict is usually two people
   editing near each other, not two people disagreeing.
4. When the two sides genuinely contradict each other, prefer "theirs" — it is what the team merged
   into the default branch — and say so in "concerns".
5. Preserve the file's existing formatting, import order and style. Do not reformat, do not
   "improve" untouched code, do not add comments about the merge.
6. If you cannot produce a merge you would stand behind, still return your best attempt but set
   confidence to "low" and put the reason in "concerns".

- rationale: two or three sentences on what you did.
- keptFromOurs / keptFromTheirs: short descriptions of the changes you preserved from each side.
- concerns: anything a human must check. Empty array only when you are genuinely sure.`;

/**
 * Read every conflicted file and ask the model for a resolution. Writes nothing.
 * Returns one proposal per file, including the raw sides so the UI can show a
 * three-way diff next to the suggestion.
 */
async function preview(repoId) {
  const repo = getRepo(repoId);
  const c = creds(repo);
  const dir = git.workdirFor(repoId, repo.url);
  const cfg = providers.resolveProvider(repo.provider_id);

  const paths = await git.conflictedPaths(dir, c);
  if (paths.length === 0) return { conflicts: [], resolutions: [] };

  progress("conflict", `Resolving ${paths.length} conflicted file(s)`);

  const resolutions = await providers.pool(
    paths,
    2, // whole-file rewrites are big; two at a time keeps memory and rate limits sane
    async (filePath) => {
      const sides = await git.conflictSides(dir, c, filePath);

      const tooBig = [sides.base, sides.ours, sides.theirs].some((s) => s.length > MAX_SIDE_CHARS);
      if (tooBig) {
        return {
          path: filePath,
          status: "manual",
          reason: `File is larger than ${Math.round(MAX_SIDE_CHARS / 1000)}KB — resolve this one by hand.`,
          sides,
        };
      }

      const result = await providers.askJson(cfg, {
        system: SYSTEM,
        user: `File: ${filePath}

===== BASE (common ancestor) =====
${sides.base}

===== OURS (local) =====
${sides.ours}

===== THEIRS (incoming, from the default branch) =====
${sides.theirs}`,
        schema: RESOLUTION_SCHEMA,
        effort: "high",
        maxTokens: 64_000,
      });

      const merged = String(result.merged || "");
      const hasMarkers = /^(<{7}|={7}|>{7})/m.test(merged);

      return {
        path: filePath,
        status: hasMarkers || merged.trim() === "" ? "manual" : "proposed",
        reason: hasMarkers
          ? "The model left conflict markers in its output — resolve this one by hand."
          : merged.trim() === ""
            ? "The model returned an empty file."
            : null,
        merged,
        rationale: result.rationale,
        confidence: hasMarkers ? "low" : result.confidence,
        keptFromOurs: result.keptFromOurs || [],
        keptFromTheirs: result.keptFromTheirs || [],
        concerns: result.concerns || [],
        sides,
      };
    },
    (done, total) => progress("conflict", `Resolved ${done}/${total}`),
  );

  const shaped = resolutions.map((r, i) =>
    r && !r.error ? r : { path: paths[i], status: "manual", reason: (r && r.error) || "resolution failed" },
  );

  emit({
    t: "conflict_preview",
    repoId,
    total: shaped.length,
    proposed: shaped.filter((r) => r.status === "proposed").length,
  });

  return { conflicts: paths, resolutions: shaped };
}

/**
 * Write approved resolutions and commit the merge.
 *
 * `resolutions` is `[{ path, contents }]` — the caller decides what goes in,
 * whether that came from the model, from "take theirs", or from a human editing
 * the proposal. Any conflicted file not in the list keeps the tree blocked.
 */
async function apply(repoId, resolutions, opts = {}) {
  const repo = getRepo(repoId);
  const c = creds(repo);
  const dir = git.workdirFor(repoId, repo.url);
  const jobId = startJob(repoId, "conflict");

  try {
    const remaining = await git.conflictedPaths(dir, c);
    const provided = new Map(resolutions.map((r) => [r.path, r.contents]));
    const unresolved = remaining.filter((p) => !provided.has(p));

    if (unresolved.length > 0 && !opts.partial) {
      throw new Error(
        `${unresolved.length} file(s) still conflicted: ${unresolved.slice(0, 5).join(", ")}${
          unresolved.length > 5 ? "…" : ""
        }`,
      );
    }

    for (const [filePath, contents] of provided) {
      await git.stageResolved(dir, c, filePath, contents);
    }

    if (unresolved.length === 0) {
      const message =
        opts.message ||
        `Merge origin/${repo.default_branch} into ${repo.default_branch}\n\nConflicts resolved by RepoDeck (${provided.size} file(s)).`;
      await git.commitMerge(dir, c, message);
      db.prepare(`UPDATE repos SET status = 'ready', status_detail = NULL WHERE id = ?`).run(repoId);
    }

    finishJob(jobId, "ok", `${provided.size} file(s) resolved, ${unresolved.length} left`);
    emit({ t: "conflict_applied", repoId, resolved: provided.size, remaining: unresolved.length });
    return { resolved: provided.size, remaining: unresolved };
  } catch (err) {
    finishJob(jobId, "error", err.message);
    throw err;
  }
}

/** Take one side wholesale, for the cases where a merge is not worth thinking about. */
async function takeSide(repoId, side) {
  const repo = getRepo(repoId);
  const c = creds(repo);
  const dir = git.workdirFor(repoId, repo.url);
  const paths = await git.conflictedPaths(dir, c);

  const resolutions = [];
  for (const p of paths) {
    const sides = await git.conflictSides(dir, c, p);
    resolutions.push({ path: p, contents: side === "ours" ? sides.ours : sides.theirs });
  }
  return apply(repoId, resolutions, { message: `Merge origin/${repo.default_branch} (took ${side})` });
}

/** Put the local work aside and take the remote exactly. Recoverable via `git stash list`. */
async function stashAndReset(repoId) {
  const repo = getRepo(repoId);
  const c = creds(repo);
  const dir = git.workdirFor(repoId, repo.url);

  await git.abortMerge(dir, c);
  await git.stashAll(dir, c, `RepoDeck auto-stash ${new Date().toISOString()}`).catch(() => {});
  const result = await git.applyUpdate(dir, c, repo.default_branch, "reset");
  db.prepare(`UPDATE repos SET status = 'ready', status_detail = NULL WHERE id = ?`).run(repoId);
  emit({ t: "conflict_stashed", repoId });
  return result;
}

/** Walk away from the merge entirely — the tree goes back to where it was. */
async function abort(repoId) {
  const repo = getRepo(repoId);
  const c = creds(repo);
  await git.abortMerge(git.workdirFor(repoId, repo.url), c);
  db.prepare(`UPDATE repos SET status = 'ready', status_detail = NULL WHERE id = ?`).run(repoId);
  return { aborted: true };
}

/**
 * The unattended path: preview, and if every file came back confident, apply.
 * Anything less leaves the repo blocked with the proposals on record, so the
 * next person to open the app sees exactly what the model wanted to do.
 */
async function autoResolve(repoId) {
  const { resolutions } = await preview(repoId);
  if (resolutions.length === 0) return { resolved: 0, blocked: false };

  const confident = resolutions.filter((r) => r.status === "proposed" && r.confidence === "high");
  if (confident.length !== resolutions.length) {
    emit({
      t: "conflict_needs_review",
      repoId,
      total: resolutions.length,
      confident: confident.length,
    });
    return { resolved: 0, blocked: true, resolutions };
  }

  await apply(
    repoId,
    confident.map((r) => ({ path: r.path, contents: r.merged })),
    { message: `Merge origin (auto-resolved by RepoDeck, ${confident.length} file(s))` },
  );
  return { resolved: confident.length, blocked: false, resolutions };
}

module.exports = { preview, apply, takeSide, stashAndReset, abort, autoResolve };
