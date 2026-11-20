import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { getDb, getFirebaseStatus } from '../config/firebase.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  AIGenerationRequest,
  AIGenerationResponse,
  AIProviderHealth,
  AIProviderName,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { COLLECTIONS } from './firestoreService.js';

interface ProviderRuntimeConfig {
  name: AIProviderName;
  configured: boolean;
  defaultModel: string;
  baseUrl?: string;
  apiKey?: string;
}

const healthMap = new Map<AIProviderName, AIProviderHealth>();

function getProviderConfigs(): Record<AIProviderName, ProviderRuntimeConfig> {
  return {
    gemini: {
      name: 'gemini',
      configured: Boolean(env.GEMINI_API_KEY),
      defaultModel: env.GEMINI_MODEL,
      apiKey: env.GEMINI_API_KEY,
    },
    openrouter: {
      name: 'openrouter',
      configured: Boolean(env.OPENROUTER_API_KEY),
      defaultModel: env.OPENROUTER_MODEL,
      baseUrl: env.OPENROUTER_BASE_URL,
      apiKey: env.OPENROUTER_API_KEY,
    },
    apinex: {
      name: 'apinex',
      configured: Boolean(env.APINEX_API_KEY && env.APINEX_BASE_URL),
      defaultModel: env.APINEX_MODEL,
      baseUrl: env.APINEX_BASE_URL,
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

function getOrInitHealth(provider: AIProviderName, configured: boolean): AIProviderHealth {
  const existing = healthMap.get(provider);
  if (existing) {
    existing.configured = configured;
    return existing;
  }
  const initial: AIProviderHealth = {
    provider,
    configured,
    healthy: configured,
    consecutiveFailures: 0,
    circuitOpenUntil: null,
  };
  healthMap.set(provider, initial);
  return initial;
}

async function persistProviderHealth(health: AIProviderHealth): Promise<void> {
  if (!getFirebaseStatus().initialized) {
    return;
  }
  try {
    await getDb().collection(COLLECTIONS.AI_PROVIDER_HEALTH).doc(health.provider).set(health, { merge: true });
  } catch {
    // Non-fatal telemetry write
  }
}

async function callGemini(
  config: ProviderRuntimeConfig,
  request: AIGenerationRequest
): Promise<{ text: string; model: string }> {
  if (!config.apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  const model = request.model || config.defaultModel;
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const response = await ai.models.generateContent({
    model,
    contents: request.prompt,
    config: {
      ...(request.systemInstruction ? { systemInstruction: request.systemInstruction } : {}),
      ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}),
      ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return { text, model };
}

async function callOpenAICompatible(
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
    headers['HTTP-Referer'] = env.OPENROUTER_SITE_URL;
    headers['X-Title'] = env.OPENROUTER_APP_NAME;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${config.name} HTTP ${response.status}: ${errorText.slice(0, 400)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error(`${config.name} returned an empty completion`);
    }

    return { text: content, model };
  } finally {
    clearTimeout(timeout);
  }
}

export class AIProviderManager {
  public getProvidersHealth(): AIProviderHealth[] {
    const configs = getProviderConfigs();
    const now = Date.now();
    return (['gemini', 'openrouter', 'apinex', 'custom'] as AIProviderName[]).map((name) => {
      const health = getOrInitHealth(name, configs[name].configured);
      if (health.circuitOpenUntil && health.circuitOpenUntil <= now) {
        health.circuitOpenUntil = null;
        health.healthy = configs[name].configured;
      }
      return { ...health };
    });
  }

  public async generateWithFailover(request: AIGenerationRequest): Promise<AIGenerationResponse> {
    const configs = getProviderConfigs();
    const baseOrder = [...env.AI_PROVIDER_LIST];
    const ordered: AIProviderName[] = request.preferredProvider
      ? [request.preferredProvider, ...baseOrder.filter((p) => p !== request.preferredProvider)]
      : baseOrder;

    const attempts: AIGenerationResponse['attempts'] = [];
    const now = Date.now();

    // Prioritize configured providers whose circuit breaker is closed; keep open-circuit ones as last-resort fallback
    const candidates = ordered.filter((name) => configs[name].configured);
    if (candidates.length === 0) {
      throw new AppError(
        'No AI providers are configured. Set at least one of GEMINI_API_KEY, OPENROUTER_API_KEY, APINEX_API_KEY, or CUSTOM_AI_API_KEY.',
        503,
        'AI_PROVIDERS_UNCONFIGURED'
      );
    }

    const healthyCandidates = candidates.filter((name) => {
      const health = getOrInitHealth(name, true);
      return !health.circuitOpenUntil || health.circuitOpenUntil <= now;
    });

    const executionQueue = healthyCandidates.length > 0 ? healthyCandidates : candidates;

    for (const providerName of executionQueue) {
      const config = configs[providerName];
      const health = getOrInitHealth(providerName, config.configured);
      const startedAt = Date.now();

      try {
        const result =
          providerName === 'gemini'
            ? await callGemini(config, request)
            : await callOpenAICompatible(config, request);

        const latencyMs = Date.now() - startedAt;
        health.healthy = true;
        health.consecutiveFailures = 0;
        health.circuitOpenUntil = null;
        health.lastSuccessAt = new Date().toISOString();
        health.averageLatencyMs = health.averageLatencyMs
          ? Math.round((health.averageLatencyMs + latencyMs) / 2)
          : latencyMs;

        await persistProviderHealth(health);

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

        health.consecutiveFailures += 1;
        health.lastFailureAt = new Date().toISOString();
        health.lastError = message.slice(0, 300);

        if (health.consecutiveFailures >= env.AI_CIRCUIT_BREAKER_THRESHOLD) {
          health.healthy = false;
          health.circuitOpenUntil = Date.now() + env.AI_CIRCUIT_BREAKER_COOLDOWN_MS;
        }

        await persistProviderHealth(health);

        attempts.push({
          provider: providerName,
          success: false,
          error: message,
          latencyMs,
        });

        logger.warn(`AI provider ${providerName} failed; attempting failover`, {
          error: message,
          consecutiveFailures: health.consecutiveFailures,
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
}

export const aiProviderManager = new AIProviderManager();
