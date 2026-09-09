"use strict";

const OpenAI = require("openai");

/**
 * OpenAI and every OpenAI-shaped endpoint (Ollama, LM Studio, vLLM, OpenRouter,
 * Azure) go through here. `kind: "compatible"` differs only in that `baseUrl` is
 * required and a key is optional — local servers usually want none.
 *
 * Local models frequently do not implement `json_schema` response formats, so a
 * failed structured call retries as `json_object` with the schema inlined in the
 * prompt, then as plain text. That keeps a small local model usable instead of
 * hard-failing the whole index.
 */
function client(cfg) {
  const Ctor = OpenAI.default || OpenAI;
  return new Ctor({
    apiKey: cfg.apiKey || "not-needed",
    baseURL: cfg.baseUrl || undefined,
    timeout: 600_000,
    maxRetries: 2,
  });
}

/** Reasoning models reject `temperature` and take `reasoning_effort` instead. */
function isReasoning(model) {
  return /^(gpt-5|o[134])/.test(String(model));
}

function tuning(cfg, effort) {
  return isReasoning(cfg.model)
    ? { reasoning_effort: effort || cfg.effort || "medium" }
    : { temperature: 0 };
}

function extractJson(raw) {
  const trimmed = String(raw || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Small models like to wrap JSON in prose or a fenced block.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
    return JSON.parse(candidate);
  }
}

async function json(cfg, { system, user, schema, effort, maxTokens }) {
  const c = client(cfg);
  const base = {
    model: cfg.model,
    max_completion_tokens: maxTokens || cfg.maxTokens || 16000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...tuning(cfg, effort),
  };

  const attempts = [
    {
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema },
      },
    },
    {
      ...base,
      messages: [
        { role: "system", content: `${system}\n\nReply with JSON matching this schema exactly:\n${JSON.stringify(schema)}` },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    },
    {
      ...base,
      messages: [
        { role: "system", content: `${system}\n\nReply with JSON only — no prose, no code fence. Schema:\n${JSON.stringify(schema)}` },
        { role: "user", content: user },
      ],
    },
  ];

  let lastError;
  for (const params of attempts) {
    try {
      const res = await c.chat.completions.create(params);
      return { data: extractJson(res.choices[0]?.message?.content), usage: res.usage };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function text(cfg, { system, user, effort, maxTokens }) {
  const res = await client(cfg).chat.completions.create({
    model: cfg.model,
    max_completion_tokens: maxTokens || 4000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...tuning(cfg, effort || "low"),
  });
  return { data: (res.choices[0]?.message?.content || "").trim(), usage: res.usage };
}

async function ping(cfg) {
  const started = Date.now();
  const res = await client(cfg).chat.completions.create({
    model: cfg.model,
    max_completion_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    ...tuning(cfg, "low"),
  });
  return { ok: true, model: res.model || cfg.model, latencyMs: Date.now() - started };
}

module.exports = { json, text, ping };
