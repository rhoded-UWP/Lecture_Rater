// Provider catalog — the single place where every swappable AI endpoint is
// declared. To add a provider or model later, add an entry here (and set its
// API key in .env); the dev panel, settings validation, and cost estimates
// all read from this file.
//
// Pricing numbers are editable estimates used ONLY for cost display — they
// never affect what a provider actually bills. Anthropic prices are current
// as of 2026-06; DeepSeek/Moonshot/AssemblyAI prices are approximate
// (marked approxPricing) — check the provider's pricing page.

export const TRANSCRIPTION_PROVIDERS = [
  {
    id: 'whisper',
    label: 'OpenAI Whisper',
    model: 'whisper-1',
    envKey: 'OPENAI_API_KEY',
    costPerMin: 0.006,
    approxPricing: false,
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI (verbatim)',
    model: 'universal-2 + disfluencies',
    envKey: 'ASSEMBLYAI_API_KEY',
    costPerMin: 0.0062, // ~$0.37/hr Universal tier
    approxPricing: true,
  },
];

export const ANALYSIS_MODELS = [
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    apiModel: 'claude-opus-4-8',
    envKey: 'ANTHROPIC_API_KEY',
    pricing: { inPerM: 5.0, outPerM: 25.0 },
    adaptiveThinking: true,
    approxPricing: false,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    apiModel: 'claude-sonnet-5',
    envKey: 'ANTHROPIC_API_KEY',
    pricing: { inPerM: 3.0, outPerM: 15.0 },
    adaptiveThinking: true,
    approxPricing: false,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    apiModel: 'claude-haiku-4-5',
    envKey: 'ANTHROPIC_API_KEY',
    pricing: { inPerM: 1.0, outPerM: 5.0 },
    adaptiveThinking: false, // Haiku 4.5 does not support adaptive thinking
    approxPricing: false,
  },
  {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat (V3)',
    provider: 'deepseek',
    providerLabel: 'DeepSeek',
    apiModel: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
    pricing: { inPerM: 0.27, outPerM: 1.1 },
    approxPricing: true,
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner (R1)',
    provider: 'deepseek',
    providerLabel: 'DeepSeek',
    apiModel: 'deepseek-reasoner',
    envKey: 'DEEPSEEK_API_KEY',
    pricing: { inPerM: 0.55, outPerM: 2.19 },
    approxPricing: true,
  },
  {
    id: 'kimi-k2',
    label: 'Kimi K2 (Moonshot)',
    provider: 'moonshot',
    providerLabel: 'Moonshot AI',
    apiModel: 'kimi-k2-turbo-preview', // edit if Moonshot renames the model
    envKey: 'MOONSHOT_API_KEY',
    pricing: { inPerM: 0.6, outPerM: 2.5 },
    approxPricing: true,
  },
];

// OpenAI-compatible chat endpoints (DeepSeek and Moonshot both mirror
// OpenAI's /chat/completions API, so one adapter serves both).
export const OPENAI_COMPAT_ENDPOINTS = {
  deepseek: 'https://api.deepseek.com/chat/completions',
  moonshot: 'https://api.moonshot.ai/v1/chat/completions',
};

export const findTranscriptionProvider = (id) =>
  TRANSCRIPTION_PROVIDERS.find((p) => p.id === id) || null;

export const findAnalysisModel = (id) =>
  ANALYSIS_MODELS.find((m) => m.id === id) || null;

export const isConfigured = (entry) => !!process.env[entry.envKey];

/** Actual dollar cost of a completed analysis call, from real token usage. */
export function analysisCostUSD(modelEntry, usage) {
  if (!modelEntry || !usage) return null;
  const cost =
    ((usage.inputTokens ?? 0) / 1e6) * modelEntry.pricing.inPerM +
    ((usage.outputTokens ?? 0) / 1e6) * modelEntry.pricing.outPerM;
  return Math.round(cost * 10000) / 10000;
}
