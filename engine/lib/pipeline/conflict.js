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

      // Do not spend a model call on something that cannot be written back as
      // text — and, more to the point, do not let a confident-looking proposal
      // for a PNG or a submodule ever reach apply().
      if (!(await writableAsText(dir, c, filePath, [sides.base, sides.ours, sides.theirs]))) {
        return {
          path: filePath,
          status: "manual",
          reason: "Not a text file — a binary, symlink or submodule conflict has to be resolved by hand.",
          sides,
        };
      }

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
      // Git writes `<<<<<<< label` and `>>>>>>> label`. Matching a bare run of
      // seven '=' as well meant a Markdown or reStructuredText heading underline
      // permanently downgraded the file to "resolve by hand".
      const hasMarkers = /^<{7}(?: |$)/m.test(merged) && /^>{7}(?: |$)/m.test(merged);

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

    // Only files git itself reports as conflicted may be written. Resolutions
    // arrive over RPC and their `path` originates from a model, so without this
    // the call is an arbitrary-write primitive: a path of "../../../.zshrc"
    // resolves outside the working tree entirely.
    const conflicted = new Set(remaining);
    // Staging a path removes it from git's conflicted list. If an earlier call
    // failed part-way through the loop below, the paths it did stage are no
    // longer "conflicted" — and rejecting them made the retry impossible, with
    // the repository stuck in a half-resolved state no button could clear. A
    // path that is already staged and resolved is not foreign; it is done.
    const alreadyResolved = new Set(await git.resolvedPaths(dir, c).catch(() => []));
    const foreign = resolutions.filter((r) => !conflicted.has(r.path) && !alreadyResolved.has(r.path));
    if (foreign.length > 0) {
      throw new Error(
        `Refusing to write ${foreign.length} file(s) git does not report as conflicted: ` +
          foreign.slice(0, 5).map((r) => r.path).join(", "),
      );
    }

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
  // Anything other than "ours" fell through to theirs, silently discarding local
  // work while the commit message said otherwise.
  if (side !== "ours" && side !== "theirs") {
    throw new Error(`Unknown side "${side}" — expected "ours" or "theirs".`);
  }

  const repo = getRepo(repoId);
  const c = creds(repo);
  const dir = git.workdirFor(repoId, repo.url);
  const paths = await git.conflictedPaths(dir, c);

  const resolutions = [];
  const missing = [];
  const unsafe = [];
  for (const p of paths) {
    const sides = await git.conflictSides(dir, c, p);
    const contents = side === "ours" ? sides.ours : sides.theirs;

    if (!(await writableAsText(dir, c, p, [sides.base, sides.ours, sides.theirs]))) {
      unsafe.push(p);
      continue;
    }
    // A delete/modify conflict has no content on one side, and `git show` of a
    // stage that does not exist returns "". Writing that would commit an empty
    // file over a real one and call it a resolution.
    if (!sides.stages || !sides.stages[side === "ours" ? "ours" : "theirs"]) {
      missing.push(p);
      continue;
    }
    resolutions.push({ path: p, contents });
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} file(s) have no "${side}" version — one side deleted them, so this is a ` +
        `delete/modify conflict that has to be resolved deliberately: ${missing.slice(0, 5).join(", ")}`,
    );
  }
  if (unsafe.length > 0) {
    throw new Error(
      `${unsafe.length} file(s) cannot be resolved as text — a binary file, a symlink or a submodule ` +
        `would be corrupted by being rewritten: ${unsafe.slice(0, 5).join(", ")}`,
    );
  }
  return apply(repoId, resolutions, { message: `Merge origin/${repo.default_branch} (took ${side})` });
}

/**
 * Can this conflicted path be resolved by writing text back?
 *
 * Three ways it cannot. The index mode may say it is not an ordinary file — a
 * conflicted symlink or a submodule gitlink passes every "git says this is
 * conflicted" check and is then destroyed by being rewritten as a blob. Or the
 * content may not be text at all: `git show` decodes a stage as UTF-8, so a PNG
 * or a UTF-16 source file comes back full of replacement characters, and
 * committing that silently corrupts the file.
 */
async function writableAsText(dir, creds, filePath, texts) {
  // Fail closed. "I could not read the mode" is not permission to overwrite the
  // file — and an unreadable mode is exactly what a path this code has mangled
  // looks like, so the two failure modes compounded.
  const modes = await git.conflictModes(dir, creds, filePath);
  if (modes.length === 0) return false;
  if (!modes.every((m) => m === "100644" || m === "100755")) return false;

  for (const text of texts) {
    if (!text) continue;
    // U+FFFD is what a failed UTF-8 decode leaves behind, and a NUL byte is
    // git's own test for "this file is binary".
    if (text.includes("\uFFFD") || text.includes("\u0000")) return false;
  }
  return true;
}

/** Put the local work aside and take the remote exactly. Recoverable via `git stash list`. */
async function stashAndReset(repoId) {
  const stamp = new Date().toISOString();
  const repo = getRepo(repoId);
  const c = creds(repo);
  const dir = git.workdirFor(repoId, repo.url);

  // Every refusal is checked BEFORE anything is touched. The first version
  // aborted the merge and stashed first, so refusing on unpushed commits left
  // the caller with an aborted merge and an emptied working tree — the exact
  // damage the refusal exists to prevent.
  const state = await git.worktreeState(dir, c, repo.default_branch);
  if (state.ahead > 0) {
    // `git stash` never saves commits. Resetting past them destroys them, and
    // they are not in the stash to recover.
    throw new Error(
      `This branch has ${state.ahead} commit(s) that are not on origin. A reset would discard them ` +
        `permanently and the stash would not contain them — resolve the conflict or move the commits first.`,
    );
  }

  await git.abortMerge(dir, c);

  // The whole promise of this path is that the work is recoverable from the
  // stash. Swallowing a failed stash and hard-resetting anyway breaks exactly
  // that promise, at the moment it matters most.
  //
  // Read the state again: aborting the merge changes it, and stashing a
  // mid-merge tree is not the same operation as stashing a settled one.
  const settled = await git.worktreeState(dir, c, repo.default_branch);
  if (settled.dirty) {
    try {
      await git.stashAll(dir, c, `RepoDeck auto-stash ${stamp}`);
    } catch (err) {
      throw new Error(
        `Refusing to reset: the working tree could not be stashed, so the changes would be lost. ${err.message}`,
      );
    }
  }

  const result = await git.applyUpdate(dir, c, repo.default_branch, "reset");
  // applyUpdate can refuse. Marking the repo ready anyway advertised a tree that
  // was never updated as resolved, and the next sync indexed the old code.
  if (!result.ok) {
    const why = result.refused || `the reset could not be applied (${result.conflicts.join(", ") || "unknown reason"})`;
    db.prepare(`UPDATE repos SET status = 'error', status_detail = ? WHERE id = ?`).run(why, repoId);
    throw new Error(why);
  }
  db.prepare(`UPDATE repos SET status = 'ready', status_detail = NULL WHERE id = ?`).run(repoId);
  emit({ t: "conflict_stashed", repoId, stashed: settled.dirty });
  return result;
}

/** Walk away from the merge entirely — the tree goes back to where it was. */
async function abort(repoId) {
  const repo = getRepo(repoId);
  const c = creds(repo);
  const dir = git.workdirFor(repoId, repo.url);
  await git.abortMerge(dir, c);

  // `git merge --abort` can fail. Marking the repo ready regardless advertised a
  // still-conflicted tree as clean, and the next sync would try to index it.
  const stillConflicted = await git.conflictedPaths(dir, c);
  if (stillConflicted.length > 0) {
    db.prepare(`UPDATE repos SET status = 'error', status_detail = ? WHERE id = ?`).run(
      `Merge conflict in ${stillConflicted.length} file(s); the abort did not complete`,
      repoId,
    );
    return { aborted: false, conflicts: stillConflicted };
  }
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

  // "high confidence" and "here are my concerns" together is not a green light —
  // the model flagging something for a human is exactly the signal to stop.
  const confident = resolutions.filter(
    (r) => r.status === "proposed" && r.confidence === "high" && (r.concerns || []).length === 0,
  );
  if (confident.length !== resolutions.length) {
    emit({
      t: "conflict_needs_review",
      repoId,
      total: resolutions.length,
      confident: confident.length,
    });
    return { resolved: 0, blocked: true, resolutions };
  }

  try {
    await apply(
      repoId,
      confident.map((r) => ({ path: r.path, contents: r.merged })),
      { message: `Merge origin (auto-resolved by RepoDeck, ${confident.length} file(s))` },
    );
  } catch (err) {
    // Throwing here escaped the scheduler's once-only guard, so the same
    // conflict was previewed again — at high effort, against a paid API — on
    // every single tick.
    emit({ t: "conflict_apply_failed", repoId, message: err.message });
    return { resolved: 0, blocked: true, error: err.message, resolutions };
  }
  return { resolved: confident.length, blocked: false, resolutions };
}

module.exports = { preview, apply, takeSide, stashAndReset, abort, autoResolve };
