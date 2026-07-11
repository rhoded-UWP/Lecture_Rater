// Analysis (LLM) adapters. One entry point — runAnalysis() — routes to:
//   · Anthropic (official SDK)
//   · any OpenAI-compatible chat API (DeepSeek, Moonshot/Kimi share one adapter)
// All adapters return the same shape:
//   { text, usage: {inputTokens, outputTokens}, model, provider, costUSD }

import Anthropic from '@anthropic-ai/sdk';
import { findAnalysisModel, OPENAI_COMPAT_ENDPOINTS, analysisCostUSD } from './catalog.js';

class AnalysisError extends Error {
  constructor(message, { status = 500, detail = '' } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- Anthropic

async function anthropicChat(entry, prompt, maxTokens) {
  const client = new Anthropic({ apiKey: process.env[entry.envKey] });
  const params = {
    model: entry.apiModel,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  // Opus/Sonnet 5-era models: let Claude decide when/how much to think.
  if (entry.adaptiveThinking) params.thinking = { type: 'adaptive' };

  let msg;
  try {
    msg = await client.messages.create(params);
  } catch (err) {
    throw new AnalysisError(`Claude request failed: ${err.message}`, {
      status: err.status === 429 ? 429 : 502,
      detail: String(err.message).slice(0, 500),
    });
  }
  return {
    text: (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
    usage: {
      inputTokens: msg.usage?.input_tokens ?? 0,
      outputTokens: msg.usage?.output_tokens ?? 0,
    },
    model: msg.model || entry.apiModel,
  };
}

// -------------------------------------------- OpenAI-compatible (DeepSeek, Kimi)

async function openaiCompatChat(entry, prompt, maxTokens) {
  const url = OPENAI_COMPAT_ENDPOINTS[entry.provider];
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env[entry.envKey]}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: entry.apiModel,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new AnalysisError(`${entry.providerLabel} request failed (${r.status})`, {
      status: 502,
      detail: detail.slice(0, 500),
    });
  }
  const data = await r.json();
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
    model: data.model || entry.apiModel,
  };
}

// ------------------------------------------------------------------ router

/** Run a single-prompt analysis on the model identified by catalog id.
 *  Throws AnalysisError with .status/.detail for route handlers. */
export async function runAnalysis(modelId, prompt, { maxTokens = 4000 } = {}) {
  const entry = findAnalysisModel(modelId);
  if (!entry) throw new AnalysisError(`Unknown analysis model: ${modelId}`, { status: 400 });
  if (!process.env[entry.envKey]) {
    throw new AnalysisError(
      `${entry.label} is not configured (${entry.envKey} missing).`,
      { status: 503 }
    );
  }
  const result =
    entry.provider === 'anthropic'
      ? await anthropicChat(entry, prompt, maxTokens)
      : await openaiCompatChat(entry, prompt, maxTokens);
  return {
    ...result,
    provider: entry.providerLabel,
    costUSD: analysisCostUSD(entry, result.usage),
  };
}

/** Pull the first JSON array or object out of an LLM response, tolerating
 *  stray prose or code fences around it. Returns null if nothing parses. */
export function extractJson(text, kind = 'object') {
  const re = kind === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = String(text).match(re);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
