"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Everything the engine persists lives under one directory the app also knows
// about, so "reveal in Finder" and a clean uninstall are both one path.
const home = os.homedir();
const root =
  process.env.REPODECK_HOME || path.join(home, "Library", "Application Support", "RepoDeck");

const config = {
  root,
  dataDir: path.join(root, "data"),          // sqlite database
  workspaceDir: path.join(root, "repos"),    // cloned working trees
  logDir: path.join(root, "logs"),           // per-repo deploy logs
  exportDir: path.join(root, "exports"),     // knowledge-graph bundles

  limits: {
    maxFileBytes: 400_000,
    maxFiles: 20_000,
    // 0 = no cap: read the branch's entire merge history.
    historyMaxMerges: 0,
    heatHalfLifeDays: 45,
    /** How much of each file the model sees, in characters. */
    fileContextChars: 6000,
    /** Test files rarely define architecture; skipping them cuts cost a lot. */
    skipTests: true,
    /** Files per mapping batch. Smaller batches = more calls, better recall. */
    mapBatchSize: 12,
    /** Parallel model calls. */
    maxConcurrency: 4,
    /** Deploy log ring buffer kept in memory for the UI. */
    logTailLines: 2000,
  },

  defaults: {
    scheduleCron: "0 3 * * *",
    /** How often the PR watcher polls GitHub, in minutes. */
    watchIntervalMin: 60,
  },
};

for (const dir of [config.dataDir, config.workspaceDir, config.logDir, config.exportDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { config };
