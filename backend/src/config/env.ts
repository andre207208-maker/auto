import dotenv from 'dotenv';
import { z } from 'zod';
import { AIProviderName } from '../types/index.js';

dotenv.config();

const optionalUrlSchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v))
  .refine((v) => !v || /^https?:\/\/.+/.test(v), {
    message: 'Must be a valid http:// or https:// URL',
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SERVICE_NAME: z.string().min(1).default('autoblogger-ai-backend'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ALLOWED_ORIGINS: z.string().default('*'),
  STRICT_ENV_VALIDATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  BACKEND_API_SECRET: z.string().optional().default(''),
  SCHEDULER_SHARED_SECRET: z.string().optional().default(''),
  ALLOW_API_KEY_AUTH: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  GOOGLE_CLOUD_PROJECT: z.string().optional().default(''),
  GOOGLE_CLOUD_LOCATION: z.string().default('asia-south1'),
  FIREBASE_PROJECT_ID: z.string().optional().default(''),
  FIRESTORE_DATABASE_ID: z.string().default('(default)'),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),

  CLOUD_TASKS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CLOUD_TASKS_LOCATION: z.string().default('asia-south1'),
  CLOUD_TASKS_QUEUE: z.string().default('autoblogger-tasks'),
  CLOUD_RUN_SERVICE_URL: optionalUrlSchema,
  CLOUD_TASKS_INVOKER_SA_EMAIL: z.string().optional().default(''),

  AI_PROVIDER_ORDER: z.string().default('gemini,openrouter,apinex,custom'),
  AI_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  AI_CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(5000).default(120000),

  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-4-hydrogen'),

  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('google/gemini-2.5-flash'),
  OPENROUTER_SITE_URL: z.string().default('https://autoblogger.local'),
  OPENROUTER_APP_NAME: z.string().default('AUTOBLOGGER AI'),

  APINEX_API_KEY: z.string().optional().default(''),
  APINEX_BASE_URL: z.string().default('https://api.apinex.io/v1'),
  APINEX_MODEL: z.string().default('gpt-4o-mini'),

  CUSTOM_AI_API_KEY: z.string().optional().default(''),
  CUSTOM_AI_BASE_URL: optionalUrlSchema,
  CUSTOM_AI_MODEL: z.string().optional().default(''),

  GOOGLE_OAUTH_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional().default(''),
  DEFAULT_BLOGGER_BLOG_ID: z.string().optional().default(''),

  GSC_SITE_URL: z.string().optional().default(''),
  GA4_PROPERTY_ID: z.string().optional().default(''),

  ADSTERRA_API_KEY: z.string().optional().default(''),
  ADSTERRA_BASE_URL: z.string().default('https://api3.adsterratools.com/publisher'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Environment validation failed: ${formatted}`);
}

const raw = parsed.data;

const validProviders: AIProviderName[] = ['gemini', 'openrouter', 'apinex', 'custom'];
const providerOrder = raw.AI_PROVIDER_ORDER.split(',')
  .map((item) => item.trim().toLowerCase() as AIProviderName)
  .filter((item): item is AIProviderName => validProviders.includes(item));

export const env = {
  ...raw,
  AI_PROVIDER_LIST: (providerOrder.length > 0 ? providerOrder : validProviders) as AIProviderName[],
  CORS_ORIGINS_LIST: raw.CORS_ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export interface EnvDiagnosticReport {
  strictMode: boolean;
  missingRequiredForFullOperation: string[];
  configuredIntegrations: {
    firebaseProjectId: boolean;
    backendApiSecret: boolean;
    schedulerSecret: boolean;
    gemini: boolean;
    openrouter: boolean;
    apinex: boolean;
    customAi: boolean;
    googleOAuth: boolean;
    bloggerDefaultId: boolean;
    searchConsole: boolean;
    ga4: boolean;
    adsterra: boolean;
    cloudTasks: boolean;
  };
}

export function getEnvDiagnostics(): EnvDiagnosticReport {
  const missing: string[] = [];

  if (!env.BACKEND_API_SECRET || env.BACKEND_API_SECRET.length < 16) {
    missing.push('BACKEND_API_SECRET (recommended >= 16 chars)');
  }
  if (!env.SCHEDULER_SHARED_SECRET || env.SCHEDULER_SHARED_SECRET.length < 16) {
    missing.push('SCHEDULER_SHARED_SECRET (recommended >= 16 chars)');
  }
  if (!env.FIREBASE_PROJECT_ID && !env.GOOGLE_CLOUD_PROJECT) {
    missing.push('FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT');
  }
  if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY && !env.APINEX_API_KEY && !env.CUSTOM_AI_API_KEY) {
    missing.push('At least one AI provider key (GEMINI_API_KEY, OPENROUTER_API_KEY, APINEX_API_KEY, or CUSTOM_AI_API_KEY)');
  }

  return {
    strictMode: env.STRICT_ENV_VALIDATION,
    missingRequiredForFullOperation: missing,
    configuredIntegrations: {
      firebaseProjectId: Boolean(env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT),
      backendApiSecret: env.BACKEND_API_SECRET.length >= 16,
      schedulerSecret: env.SCHEDULER_SHARED_SECRET.length >= 16,
      gemini: Boolean(env.GEMINI_API_KEY),
      openrouter: Boolean(env.OPENROUTER_API_KEY),
      apinex: Boolean(env.APINEX_API_KEY),
      customAi: Boolean(env.CUSTOM_AI_API_KEY && env.CUSTOM_AI_BASE_URL),
      googleOAuth: Boolean(
        env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN
      ),
      bloggerDefaultId: Boolean(env.DEFAULT_BLOGGER_BLOG_ID),
      searchConsole: Boolean(env.GSC_SITE_URL),
      ga4: Boolean(env.GA4_PROPERTY_ID),
      adsterra: Boolean(env.ADSTERRA_API_KEY),
      cloudTasks: env.CLOUD_TASKS_ENABLED && Boolean(env.CLOUD_RUN_SERVICE_URL),
    },
  };
}

export function assertStrictEnvironment(): void {
  const diagnostics = getEnvDiagnostics();
  if (env.STRICT_ENV_VALIDATION && diagnostics.missingRequiredForFullOperation.length > 0) {
    throw new Error(
      `STRICT_ENV_VALIDATION enabled. Missing required configuration: ${diagnostics.missingRequiredForFullOperation.join(', ')}`
    );
  }
}
