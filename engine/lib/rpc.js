"use strict";

// Line-delimited JSON-RPC over stdio, used by the RepoDeck app to drive a
// long-lived engine process.
//
// Request  (app → engine):  { "id": 7, "method": "repo.index", "params": {…} }
// Response (engine → app):  { "id": 7, "ok": true,  "result": {…} }
//                           { "id": 7, "ok": false, "error": "…" }
// Event    (engine → app):  { "t": "progress", "req": 7, … }
//
// Requests are dispatched concurrently — a full re-index of one repo must not
// block a graph query on another — so responses can arrive out of order. The
// app correlates by `id`.
//
// Secrets only ever travel over this pipe, never argv or env.

const { emit, withRequest } = require("./events");

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/// Start the read loop. `methods` maps name → async (params, ctx) => result.
function serve(methods) {
  let buffer = "";
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) dispatch(methods, line);
    }
  });

  process.stdin.on("end", () => process.exit(0));
  emit({ t: "ready", protocol: 1, pid: process.pid });
}

function dispatch(methods, line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    emit({ t: "fatal", message: `bad rpc frame: ${err.message}` });
    return;
  }

  const { id, method, params } = req;
  const fn = methods[method];
  if (typeof fn !== "function") {
    write({ id, ok: false, error: `unknown method "${method}"` });
    return;
  }

  // Everything the handler emits is tagged with this request id, so the app can
  // route progress to the screen that asked for it.
  withRequest(id, () =>
    Promise.resolve()
      .then(() => fn(params || {}, { id }))
      .then(
        (result) => write({ id, ok: true, result: result === undefined ? null : result }),
        (err) => write({ id, ok: false, error: errorMessage(err) }),
      ),
  );
}

function errorMessage(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

module.exports = { serve, write };
