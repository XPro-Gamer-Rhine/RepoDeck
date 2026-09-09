"use strict";

const Anthropic = require("@anthropic-ai/sdk");

/**
 * Anthropic-backed model calls.
 *
 * Thinking is left at the default: on Claude Opus 5 omitting `thinking` runs
 * adaptive thinking, which is what we want for schema-heavy code reasoning.
 * Depth is steered with `output_config.effort` instead of a token budget —
 * `budget_tokens` is removed on current models and returns a 400.
 */
function client(cfg) {
  const Ctor = Anthropic.default || Anthropic;
  return new Ctor({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl || undefined,
    timeout: 600_000,
    maxRetries: 2,
  });
}

function textOf(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function json(cfg, { system, user, schema, effort, maxTokens }) {
  const res = await client(cfg).messages.create({
    model: cfg.model,
    max_tokens: maxTokens || cfg.maxTokens || 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: {
      effort: effort || cfg.effort || "high",
      format: { type: "json_schema", schema },
    },
  });

  // A safety decline arrives as HTTP 200 with stop_reason "refusal" — check it
  // before trusting the content, or we'd parse an empty body and blame the schema.
  if (res.stop_reason === "refusal") {
    const why = res.stop_details && res.stop_details.explanation;
    throw new Error(`The model declined this request${why ? `: ${why}` : "."}`);
  }

  const raw = textOf(res);
  return { data: JSON.parse(raw || "{}"), usage: res.usage };
}

async function text(cfg, { system, user, effort, maxTokens }) {
  const res = await client(cfg).messages.create({
    model: cfg.model,
    max_tokens: maxTokens || 4000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: effort || "low" },
  });
  if (res.stop_reason === "refusal") return { data: "", usage: res.usage };
  return { data: textOf(res), usage: res.usage };
}

async function ping(cfg) {
  const started = Date.now();
  const res = await client(cfg).messages.create({
    model: cfg.model,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    output_config: { effort: "low" },
  });
  return { ok: true, model: res.model, latencyMs: Date.now() - started };
}

module.exports = { json, text, ping };
