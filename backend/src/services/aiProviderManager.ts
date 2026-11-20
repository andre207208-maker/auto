import { listProviderHealthRows, upsertProviderHealthRow } from '../db/repositories.js';
import {
  AIGenerationRequest,
  AIGenerationResponse,
  AIProviderHealth,
  AIProviderName,
  WorkerEnv,
} from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface ProviderRuntimeConfig {
  name: AIProviderName;
  configured: boolean;
  defaultModel: string;
  baseUrl?: string;
  apiKey?: string;
}

const VALID_PROVIDERS: AIProviderName[] = ['gemini', 'openrouter', 'apinex', 'custom'];

function getProviderOrder(env: WorkerEnv): AIProviderName[] {
  const raw = env.AI_PROVIDER_ORDER || 'gemini,openrouter,apinex,custom';
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase() as AIProviderName)
    .filter((p): p is AIProviderName => VALID_PROVIDERS.includes(p));
  return parsed.length > 0 ? parsed : VALID_PROVIDERS;
}

function getProviderConfigs(env: WorkerEnv): Record<AIProviderName, ProviderRuntimeConfig> {
  return {
    gemini: {
      name: 'gemini',
      configured: Boolean(env.GEMINI_API_KEY),
      defaultModel: env.GEMINI_MODEL || 'gemini-4-hydrogen',
      apiKey: env.GEMINI_API_KEY,
    },
    openrouter: {
      name: 'openrouter',
      configured: Boolean(env.OPENROUTER_API_KEY),
      defaultModel: env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
    },
    apinex: {
      name: 'apinex',
      configured: Boolean(env.APINEX_API_KEY),
      defaultModel: env.APINEX_MODEL || 'gpt-4o-mini',
      baseUrl: env.APINEX_BASE_URL || 'https://api.apinex.io/v1',
      apiKey: env.APINEX_API_KEY,
    },
    custom: {
      name: 'custom',
      configured: Boolean(env.CUSTOM_AI_API_KEY && env.CUSTOM_AI_BASE_URL && env.CUSTOM_AI_MODEL),
      defaultModel: env.CUSTOM_AI_MODEL || 'gpt-4o-mini',
      baseUrl: env.CUSTOM_AI_BASE_URL,
      apiKey: env.CUSTOM_AI_API_KEY,
    },
  };
}

async function callGeminiRest(
  config: ProviderRuntimeConfig,
  request: AIGenerationRequest
): Promise<{ text: string; model: string }> {
  if (!config.apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  const model = request.model || config.defaultModel;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
  };

  if (request.systemInstruction) {
    body.systemInstruction = { parts: [{ text: request.systemInstruction }] };
  }

  const generationConfig: Record<string, unknown> = {};
  if (request.jsonMode) {
    generationConfig.responseMimeType = 'application/json';
  }
  if (request.maxTokens) {
    generationConfig.maxOutputTokens = request.maxTokens;
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`gemini HTTP ${response.status}: ${errText.slice(0, 400)}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return { text, model };
}

async function callOpenAICompatible(
  env: WorkerEnv,
  config: ProviderRuntimeConfig,
  request: AIGenerationRequest
): Promise<{ text: string; model: string }> {
  if (!config.apiKey || !config.baseUrl) {
    throw new Error(`${config.name} API key or base URL is not configured`);
  }

  const model = request.model || config.defaultModel;
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const messages: Array<{ role: string; content: string }> = [];
  if (request.systemInstruction) {
    messages.push({ role: 'system', content: request.systemInstruction });
  }
  messages.push({ role: 'user', content: request.prompt });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };

  if (config.name === 'openrouter') {
    headers['HTTP-Referer'] = env.OPENROUTER_SITE_URL || 'https://autoblogger.local';
    headers['X-Title'] = env.OPENROUTER_APP_NAME || 'AUTOBLOGGER AI';
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${config.name} HTTP ${response.status}: ${errText.slice(0, 400)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error(`${config.name} returned an empty completion`);
  }

  return { text: content, model };
}

export async function getProvidersHealth(env: WorkerEnv): Promise<AIProviderHealth[]> {
  const configs = getProviderConfigs(env);
  const stored = await listProviderHealthRows(env.DB);
  const now = Date.now();

  return VALID_PROVIDERS.map((name) => {
    const cfg = configs[name];
    const row = stored[name];
    const openUntil = row?.circuitOpenUntil && row.circuitOpenUntil > now ? row.circuitOpenUntil : null;
    return {
      provider: name,
      configured: cfg.configured,
      healthy: cfg.configured && openUntil === null,
      consecutiveFailures: row?.consecutiveFailures ?? 0,
      circuitOpenUntil: openUntil,
      lastError: row?.lastError ?? null,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      lastFailureAt: row?.lastFailureAt ?? null,
      averageLatencyMs: row?.averageLatencyMs ?? null,
    };
  });
}

export async function generateWithFailover(
  env: WorkerEnv,
  request: AIGenerationRequest
): Promise<AIGenerationResponse> {
  const configs = getProviderConfigs(env);
  const baseOrder = getProviderOrder(env);
  const ordered: AIProviderName[] = request.preferredProvider
    ? [request.preferredProvider, ...baseOrder.filter((p) => p !== request.preferredProvider)]
    : baseOrder;

  const candidates = ordered.filter((name) => configs[name].configured);
  if (candidates.length === 0) {
    throw new AppError(
      'No AI providers are configured. Set at least one of GEMINI_API_KEY, OPENROUTER_API_KEY, APINEX_API_KEY, or CUSTOM_AI_API_KEY.',
      503,
      'AI_PROVIDERS_UNCONFIGURED'
    );
  }

  const healthList = await getProvidersHealth(env);
  const healthByProvider = new Map(healthList.map((h) => [h.provider, h]));
  const now = Date.now();

  const healthyCandidates = candidates.filter((name) => {
    const h = healthByProvider.get(name);
    return !h?.circuitOpenUntil || h.circuitOpenUntil <= now;
  });

  const executionQueue = healthyCandidates.length > 0 ? healthyCandidates : candidates;
  const threshold = Number(env.AI_CIRCUIT_BREAKER_THRESHOLD || '3');
  const cooldownMs = Number(env.AI_CIRCUIT_BREAKER_COOLDOWN_MS || '120000');

  const attempts: AIGenerationResponse['attempts'] = [];

  for (const providerName of executionQueue) {
    const cfg = configs[providerName];
    const health = healthByProvider.get(providerName) || {
      provider: providerName,
      configured: cfg.configured,
      healthy: true,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
    };

    const startedAt = Date.now();
    try {
      const result =
        providerName === 'gemini'
          ? await callGeminiRest(cfg, request)
          : await callOpenAICompatible(env, cfg, request);

      const latencyMs = Date.now() - startedAt;
      const updatedHealth: AIProviderHealth = {
        provider: providerName,
        configured: true,
        healthy: true,
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        lastError: null,
        lastSuccessAt: new Date().toISOString(),
        lastFailureAt: health.lastFailureAt ?? null,
        averageLatencyMs: health.averageLatencyMs
          ? Math.round((health.averageLatencyMs + latencyMs) / 2)
          : latencyMs,
      };
      await upsertProviderHealthRow(env.DB, updatedHealth);

      attempts.push({ provider: providerName, success: true, latencyMs });
      return {
        text: result.text,
        provider: providerName,
        model: result.model,
        latencyMs,
        attempts,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      const consecutiveFailures = (health.consecutiveFailures || 0) + 1;
      const tripCircuit = consecutiveFailures >= threshold;

      const updatedHealth: AIProviderHealth = {
        provider: providerName,
        configured: true,
        healthy: !tripCircuit,
        consecutiveFailures,
        circuitOpenUntil: tripCircuit ? Date.now() + cooldownMs : null,
        lastError: message.slice(0, 300),
        lastSuccessAt: health.lastSuccessAt ?? null,
        lastFailureAt: new Date().toISOString(),
        averageLatencyMs: health.averageLatencyMs ?? null,
      };
      await upsertProviderHealthRow(env.DB, updatedHealth);

      attempts.push({ provider: providerName, success: false, error: message, latencyMs });
      logger.warn(`AI provider ${providerName} failed; attempting failover`, {
        error: message,
        consecutiveFailures,
      });
    }
  }

  throw new AppError(
    'All configured AI providers failed during generation',
    502,
    'AI_ALL_PROVIDERS_FAILED',
    { attempts }
  );
}
