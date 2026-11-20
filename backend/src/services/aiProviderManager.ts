import {
  getAppSetting,
  listProviderHealthRows,
  setAppSetting,
  upsertProviderHealthRow,
} from '../db/repositories.js';
import {
  AIGenerationRequest,
  AIGenerationResponse,
  AIProviderHealth,
  AIProviderName,
  WorkerEnv,
} from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

interface ProviderRuntimeConfig {
  name: AIProviderName;
  configured: boolean;
  defaultModel: string;
  baseUrl?: string;
  apiKeys: string[];
}

const VALID_PROVIDERS: AIProviderName[] = ['gemini', 'openrouter', 'apinex', 'custom'];
const PRIORITY_SETTING_KEY = 'ai_provider_priority';

function parseApiKeys(multiValue?: string, singleValue?: string): string[] {
  const combined = [multiValue || '', singleValue || '']
    .join(',')
    .split(/[\n,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  return Array.from(new Set(combined));
}

function parseProviderOrder(raw?: string | null): AIProviderName[] {
  if (!raw) {
    return [...VALID_PROVIDERS];
  }
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase() as AIProviderName)
    .filter((p): p is AIProviderName => VALID_PROVIDERS.includes(p));
  const unique = Array.from(new Set(parsed));
  for (const p of VALID_PROVIDERS) {
    if (!unique.includes(p)) {
      unique.push(p);
    }
  }
  return unique;
}

export async function getProviderPriorityOrder(env: WorkerEnv): Promise<AIProviderName[]> {
  const stored = await getAppSetting<AIProviderName[]>(env.DB, PRIORITY_SETTING_KEY);
  if (Array.isArray(stored) && stored.length > 0) {
    const validStored = stored.filter((p): p is AIProviderName => VALID_PROVIDERS.includes(p));
    if (validStored.length > 0) {
      for (const p of VALID_PROVIDERS) {
        if (!validStored.includes(p)) {
          validStored.push(p);
        }
      }
      return validStored;
    }
  }
  return parseProviderOrder(env.AI_PROVIDER_ORDER);
}

export async function setProviderPriorityOrder(
  env: WorkerEnv,
  order: AIProviderName[],
  updatedBy: string
): Promise<AIProviderName[]> {
  const unique = Array.from(
    new Set(order.filter((p): p is AIProviderName => VALID_PROVIDERS.includes(p)))
  );
  for (const p of VALID_PROVIDERS) {
    if (!unique.includes(p)) {
      unique.push(p);
    }
  }
  await setAppSetting(env.DB, PRIORITY_SETTING_KEY, unique, updatedBy);
  return unique;
}

function getProviderConfigs(env: WorkerEnv): Record<AIProviderName, ProviderRuntimeConfig> {
  const geminiKeys = parseApiKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY);
  const openrouterKeys = parseApiKeys(env.OPENROUTER_API_KEYS, env.OPENROUTER_API_KEY);
  const apinexKeys = parseApiKeys(env.APINEX_API_KEYS, env.APINEX_API_KEY);
  const customKeys = parseApiKeys(env.CUSTOM_AI_API_KEYS, env.CUSTOM_AI_API_KEY);

  return {
    gemini: {
      name: 'gemini',
      configured: geminiKeys.length > 0,
      defaultModel: env.GEMINI_MODEL || 'gemini-4-hydrogen',
      apiKeys: geminiKeys,
    },
    openrouter: {
      name: 'openrouter',
      configured: openrouterKeys.length > 0,
      defaultModel: env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKeys: openrouterKeys,
    },
    apinex: {
      name: 'apinex',
      configured: apinexKeys.length > 0,
      defaultModel: env.APINEX_MODEL || 'gpt-4o-mini',
      baseUrl: env.APINEX_BASE_URL || 'https://api.apinex.io/v1',
      apiKeys: apinexKeys,
    },
    custom: {
      name: 'custom',
      configured: Boolean(customKeys.length > 0 && env.CUSTOM_AI_BASE_URL && env.CUSTOM_AI_MODEL),
      defaultModel: env.CUSTOM_AI_MODEL || 'gpt-4o-mini',
      baseUrl: env.CUSTOM_AI_BASE_URL,
      apiKeys: customKeys,
    },
  };
}

class ProviderHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly isRateOrQuotaError: boolean
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

function detectRateOrQuotaExhaustion(status: number, bodyText: string): boolean {
  if (status === 429 || status === 402) {
    return true;
  }
  const lower = bodyText.toLowerCase();
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('insufficient_quota') ||
    lower.includes('rate_limit') ||
    lower.includes('quota exceeded') ||
    lower.includes('too many requests')
  );
}

async function callGeminiRest(
  config: ProviderRuntimeConfig,
  apiKey: string,
  request: AIGenerationRequest
): Promise<{ text: string; model: string }> {
  const model = request.model || config.defaultModel;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
    throw new ProviderHttpError(
      `gemini HTTP ${response.status}: ${errText.slice(0, 300)}`,
      response.status,
      detectRateOrQuotaExhaustion(response.status, errText)
    );
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    throw new ProviderHttpError('Gemini returned an empty response', 502, false);
  }

  return { text, model };
}

async function callOpenAICompatible(
  env: WorkerEnv,
  config: ProviderRuntimeConfig,
  apiKey: string,
  request: AIGenerationRequest
): Promise<{ text: string; model: string }> {
  if (!config.baseUrl) {
    throw new ProviderHttpError(`${config.name} base URL is not configured`, 503, false);
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
    Authorization: `Bearer ${apiKey}`,
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
    throw new ProviderHttpError(
      `${config.name} HTTP ${response.status}: ${errText.slice(0, 300)}`,
      response.status,
      detectRateOrQuotaExhaustion(response.status, errText)
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new ProviderHttpError(`${config.name} returned an empty completion`, 502, false);
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
      keyCount: cfg.apiKeys.length,
      healthy: cfg.configured && openUntil === null,
      consecutiveFailures: row?.consecutiveFailures ?? 0,
      circuitOpenUntil: openUntil,
      totalRequests: row?.totalRequests ?? 0,
      totalErrors: row?.totalErrors ?? 0,
      rateLimitHits: row?.rateLimitHits ?? 0,
      lastModelUsed: row?.lastModelUsed ?? null,
      lastError: row?.lastError ?? null,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      lastFailureAt: row?.lastFailureAt ?? null,
      averageLatencyMs: row?.averageLatencyMs ?? null,
    };
  });
}

export async function resetProvidersHealth(env: WorkerEnv): Promise<AIProviderHealth[]> {
  const configs = getProviderConfigs(env);
  for (const name of VALID_PROVIDERS) {
    const cfg = configs[name];
    await upsertProviderHealthRow(env.DB, {
      provider: name,
      configured: cfg.configured,
      keyCount: cfg.apiKeys.length,
      healthy: cfg.configured,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      totalRequests: 0,
      totalErrors: 0,
      rateLimitHits: 0,
      lastModelUsed: null,
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      averageLatencyMs: null,
    });
  }
  return getProvidersHealth(env);
}

export async function generateWithFailover(
  env: WorkerEnv,
  request: AIGenerationRequest
): Promise<AIGenerationResponse> {
  const configs = getProviderConfigs(env);
  const baseOrder = await getProviderPriorityOrder(env);
  const ordered: AIProviderName[] = request.preferredProvider
    ? [request.preferredProvider, ...baseOrder.filter((p) => p !== request.preferredProvider)]
    : baseOrder;

  const candidates = ordered.filter((name) => configs[name].configured);
  if (candidates.length === 0) {
    throw new AppError(
      'No AI providers are configured. Set at least one of GEMINI_API_KEY(S), OPENROUTER_API_KEY(S), APINEX_API_KEY(S), or CUSTOM_AI_API_KEY(S).',
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

  // Bounded execution queue prevents infinite retry loops
  const executionQueue = healthyCandidates.length > 0 ? healthyCandidates : candidates;
  const threshold = Math.max(1, Number(env.AI_CIRCUIT_BREAKER_THRESHOLD || '3'));
  const cooldownMs = Math.max(10_000, Number(env.AI_CIRCUIT_BREAKER_COOLDOWN_MS || '120000'));

  const attempts: AIGenerationResponse['attempts'] = [];

  for (const providerName of executionQueue) {
    const cfg = configs[providerName];
    const health = healthByProvider.get(providerName) || {
      provider: providerName,
      configured: cfg.configured,
      keyCount: cfg.apiKeys.length,
      healthy: true,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      totalRequests: 0,
      totalErrors: 0,
      rateLimitHits: 0,
    };

    let totalRequests = health.totalRequests;
    let totalErrors = health.totalErrors;
    let rateLimitHits = health.rateLimitHits;
    let lastErrMessage = '';
    let providerSucceeded = false;

    // Rotate across configured API keys for this provider (bounded by cfg.apiKeys.length)
    for (let keyIdx = 0; keyIdx < cfg.apiKeys.length; keyIdx++) {
      const apiKey = cfg.apiKeys[keyIdx];
      const startedAt = Date.now();
      totalRequests += 1;

      try {
        const result = await withRetry(
          async () => {
            return providerName === 'gemini'
              ? callGeminiRest(cfg, apiKey, request)
              : callOpenAICompatible(env, cfg, apiKey, request);
          },
          {
            operationName: `ai_${providerName}_key_${keyIdx}`,
            maxAttempts: 2,
            baseDelayMs: 250,
            maxDelayMs: 1200,
            // Only retry transient 5xx on the same key; immediately rotate key/provider on 429/quota
            shouldRetry: (err) =>
              err instanceof ProviderHttpError &&
              !err.isRateOrQuotaError &&
              err.statusCode >= 500,
          }
        );

        const latencyMs = Date.now() - startedAt;
        await upsertProviderHealthRow(env.DB, {
          provider: providerName,
          configured: true,
          keyCount: cfg.apiKeys.length,
          healthy: true,
          consecutiveFailures: 0,
          circuitOpenUntil: null,
          totalRequests,
          totalErrors,
          rateLimitHits,
          lastModelUsed: result.model,
          lastError: null,
          lastSuccessAt: new Date().toISOString(),
          lastFailureAt: health.lastFailureAt ?? null,
          averageLatencyMs: health.averageLatencyMs
            ? Math.round((health.averageLatencyMs + latencyMs) / 2)
            : latencyMs,
        });

        attempts.push({ provider: providerName, keyIndex: keyIdx, success: true, latencyMs });
        providerSucceeded = true;

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
        const rateLimited = err instanceof ProviderHttpError && err.isRateOrQuotaError;

        totalErrors += 1;
        if (rateLimited) {
          rateLimitHits += 1;
        }
        lastErrMessage = message;

        attempts.push({
          provider: providerName,
          keyIndex: keyIdx,
          success: false,
          rateLimited,
          error: message,
          latencyMs,
        });

        logger.warn(`AI provider ${providerName} key #${keyIdx} failed`, {
          rateLimited,
          error: message,
          hasMoreKeys: keyIdx < cfg.apiKeys.length - 1,
        });

        // If the error is auth/400 bad request (not rate limit or 5xx), don't waste remaining keys
        if (
          err instanceof ProviderHttpError &&
          !err.isRateOrQuotaError &&
          err.statusCode >= 400 &&
          err.statusCode < 500
        ) {
          break;
        }
      }
    }

    if (!providerSucceeded) {
      const consecutiveFailures = (health.consecutiveFailures || 0) + 1;
      const tripCircuit = consecutiveFailures >= threshold;

      await upsertProviderHealthRow(env.DB, {
        provider: providerName,
        configured: true,
        keyCount: cfg.apiKeys.length,
        healthy: !tripCircuit,
        consecutiveFailures,
        circuitOpenUntil: tripCircuit ? Date.now() + cooldownMs : null,
        totalRequests,
        totalErrors,
        rateLimitHits,
        lastModelUsed: health.lastModelUsed ?? null,
        lastError: lastErrMessage.slice(0, 300),
        lastSuccessAt: health.lastSuccessAt ?? null,
        lastFailureAt: new Date().toISOString(),
        averageLatencyMs: health.averageLatencyMs ?? null,
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
