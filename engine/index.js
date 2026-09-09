#!/usr/bin/env node
"use strict";

// CLI entrypoint driven by the RepoDeck macOS app.
//
//   node index.js daemon        long-lived JSON-RPC server (what the app uses)
//   node index.js index <id>    one-shot re-index of a repo, for cron/debugging
//
// Secrets (GitHub tokens, model API keys) are never read from argv or the
// environment: the app pushes them over stdin once the pipe is live, and the
// engine keeps them in memory for the session only. Nothing secret is written
// to the database or to disk.
//
// All machine-readable output is NDJSON on stdout (see lib/events.js).

const { emit } = require("./lib/events");

// node:sqlite is still flagged experimental on some releases and prints a
// warning to stderr on first use. The app reads the engine's stderr as a log
// stream, so an unactionable warning would surface in the UI on every launch.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  process.stderr.write(`${warning.stack || warning.message}\n`);
});

const { runDaemon } = require("./lib/daemon");

async function main() {
  const command = process.argv[2] || "daemon";

  if (command === "daemon") {
    await runDaemon(); // resolves only when stdin closes
    return;
  }

  if (command === "index") {
    const repoId = Number(process.argv[3]);
    if (!repoId) throw new Error("usage: index <repoId>");
    const { indexRepo } = require("./lib/pipeline/ingest");
    await indexRepo(repoId, { full: process.argv.includes("--full") });
    return;
  }

  emit({ t: "fatal", message: `unknown command "${command}" (use: daemon | index)` });
  process.exit(2);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    emit({ t: "fatal", message: err && err.stack ? err.stack : String(err) });
    process.exit(1);
  });
