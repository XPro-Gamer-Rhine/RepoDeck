"use strict";

// NDJSON event stream — one JSON object per line on stdout.
//
// Every line the app reads is either an RPC response (has `id`, see rpc.js) or
// an event (has `t`). Events emitted while a request is in flight carry that
// request's id in `req`, so the app can route a clone's progress to the repo
// card that asked for it instead of broadcasting it everywhere.

const { AsyncLocalStorage } = require("node:async_hooks");

const requestScope = new AsyncLocalStorage();

function emit(event) {
  const req = requestScope.getStore();
  const line = req == null ? event : { req, ...event };
  process.stdout.write(JSON.stringify(line) + "\n");
}

/// Run `fn` with every event it emits tagged with this request id.
function withRequest(id, fn) {
  return requestScope.run(id, fn);
}

/// Progress line for a long-running job. `phase` is a stable machine key,
/// `message` is what the UI shows.
function progress(phase, message, extra = {}) {
  emit({ t: "progress", phase, message, ...extra });
}

function logLine(stream, text) {
  emit({ t: "log", stream, text });
}

module.exports = { emit, withRequest, progress, logLine };
