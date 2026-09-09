"use strict";

// One interface over every model backend the user can configure.
//
// A provider row in the database holds a *label*, a kind, a model name and a
// Keychain ref — never a key. This module resolves the ref against the
// in-memory vault at call time, routes to the right adapter, retries transient
// failures, and keeps a running token tally so the UI can show what an index cost.

const { db, json: parseJson } = require("../db");
const secrets = require("../secrets");
const anthropic = require("./anthropic");
const openaiish = require("./openai");

const ADAPTERS = {
  anthropic,
  openai: openaiish,
  compatible: openaiish,
};

const usage = { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 };

function resetUsage() {
  usage.calls = 0;
  usage.inputTokens = 0;
  usage.outputTokens = 0;
  usage.failures = 0;
}

function snapshotUsage() {
  return { ...usage };
}

function countUsage(u) {
  if (!u) return;
  usage.inputTokens += u.input_tokens ?? u.prompt_tokens ?? 0;
  usage.outputTokens += u.output_tokens ?? u.completion_tokens ?? 0;
}

/** The provider a repo should use: its own, else the default, else the only one. */
function resolveProvider(repoProviderId) {
  const byId = repoProviderId
    ? db.prepare(`SELECT * FROM providers WHERE id = ?`).get(repoProviderId)
    : null;
  const row =
    byId ||
    db.prepare(`SELECT * FROM providers WHERE is_default = 1 ORDER BY id LIMIT 1`).get() ||
    db.prepare(`SELECT * FROM providers ORDER BY id LIMIT 1`).get();

  if (!row) {
    throw new Error(
      "No AI provider configured. Add one in Settings → AI — a Claude or OpenAI key, or a local endpoint.",
    );
  }
  return toConfig(row);
}

function toConfig(row, { fast = false } = {}) {
  const apiKey = row.key_ref ? secrets.get(row.key_ref) : null;
  if (!apiKey && row.kind !== "compatible") {
    throw new Error(
      `The API key for "${row.label}" isn't unlocked. Re-enter it in Settings → AI.`,
    );
  }
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    baseUrl: row.base_url || null,
    model: fast && row.fast_model ? row.fast_model : row.model,
    effort: row.effort || "high",
    maxTokens: row.max_tokens || 16000,
    apiKey,
  };
}

/** Same provider, but the cheaper model when one is configured. */
function fastVariant(cfg) {
  const row = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(cfg.id);
  return row ? toConfig(row, { fast: true }) : cfg;
}

const RETRYABLE = /rate limit|429|timeout|ETIMEDOUT|ECONNRESET|overloaded|502|503|504/i;

async function withRetry(fn, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === attempts - 1 || !RETRYABLE.test(err.message || "")) break;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
    }
  }
  usage.failures++;
  throw lastError;
}

/** Structured call: returns the parsed object, validated by the backend's schema mode. */
async function askJson(cfg, opts) {
  const adapter = ADAPTERS[cfg.kind];
  if (!adapter) throw new Error(`Unknown provider kind "${cfg.kind}"`);
  const { data, usage: u } = await withRetry(() => adapter.json(cfg, opts));
  usage.calls++;
  countUsage(u);
  return data;
}

/** Prose call, for summaries the UI shows verbatim. */
async function askText(cfg, opts) {
  const adapter = ADAPTERS[cfg.kind];
  if (!adapter) throw new Error(`Unknown provider kind "${cfg.kind}"`);
  const { data, usage: u } = await withRetry(() => adapter.text(cfg, opts));
  usage.calls++;
  countUsage(u);
  return data;
}

async function ping(row) {
  const adapter = ADAPTERS[row.kind];
  if (!adapter) throw new Error(`Unknown provider kind "${row.kind}"`);
  return adapter.ping(toConfig(row));
}

/**
 * Run `worker` over `items` with bounded concurrency, tolerating individual
 * failures: one bad batch must not sink an index that is 90% done.
 */
async function pool(items, limit, worker, onProgress) {
  const queue = items.map((item, index) => ({ item, index }));
  const results = new Array(items.length);
  let done = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try {
        results[next.index] = await worker(next.item, next.index);
      } catch (err) {
        results[next.index] = { error: err.message };
      }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Provider rows for the UI, with the key value replaced by whether it's unlocked. */
function listProviders() {
  return db
    .prepare(`SELECT * FROM providers ORDER BY is_default DESC, id`)
    .all()
    .map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      baseUrl: r.base_url,
      model: r.model,
      fastModel: r.fast_model,
      effort: r.effort,
      maxTokens: r.max_tokens,
      isDefault: Boolean(r.is_default),
      keyRef: r.key_ref,
      unlocked: r.kind === "compatible" ? true : secrets.has(r.key_ref),
    }));
}

module.exports = {
  resolveProvider,
  fastVariant,
  askJson,
  askText,
  ping,
  pool,
  listProviders,
  resetUsage,
  snapshotUsage,
  parseJson,
};
