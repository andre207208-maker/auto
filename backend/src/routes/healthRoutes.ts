import { Hono } from 'hono';
import { checkDbHealth } from '../db/repositories.js';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import { getAgentState } from '../services/agentControlService.js';
import { getProvidersHealth } from '../services/aiProviderManager.js';
import { WorkerEnv } from '../types/index.js';

const healthRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

healthRoutes.get('/health', async (c) => {
  const dbConnected = await checkDbHealth(c.env.DB);
  let agentStatus = 'unknown';

  if (dbConnected) {
    try {
      const state = await getAgentState(c.env);
      agentStatus = state.status;
    } catch {
      agentStatus = 'unavailable';
    }
  }

  return c.json(
    {
      status: 'ok',
      service: c.env.SERVICE_NAME || 'autoblogger-ai',
      version: '2.0.0',
      platform: 'cloudflare-workers',
      runtime: 'cloudflare-workers',
      environment: c.env.ENVIRONMENT || 'production',
      timestamp: new Date().toISOString(),
      dbConnected,
      queueConfigured: dbConnected,
      queueBackend: 'd1',
      r2Configured: false,
      mediaStorageBackend: 'd1',
      agentStatus,
    },
    200
  );
});

healthRoutes.get('/api/v1/health/detailed', requireAuth, async (c) => {
  const dbConnected = await checkDbHealth(c.env.DB);
  const agentState = dbConnected ? await getAgentState(c.env) : null;
  const aiProviders = dbConnected ? await getProvidersHealth(c.env) : [];

  return c.json({
    status: 'ok',
    service: c.env.SERVICE_NAME || 'autoblogger-ai',
    platform: 'cloudflare-workers',
    runtime: 'cloudflare-workers',
    timestamp: new Date().toISOString(),
    bindings: {
      d1Database: dbConnected,
      taskQueue: dbConnected,
      d1JobQueue: dbConnected,
      d1MediaStorage: dbConnected,
      r2Bucket: false,
    },
    configuredSecrets: {
      backendApiSecret: Boolean(c.env.BACKEND_API_SECRET && c.env.BACKEND_API_SECRET.length >= 16),
      schedulerSecret: Boolean(
        c.env.SCHEDULER_SHARED_SECRET && c.env.SCHEDULER_SHARED_SECRET.length >= 16
      ),
      firebaseProjectId: Boolean(c.env.FIREBASE_PROJECT_ID),
      gemini: Boolean(c.env.GEMINI_API_KEYS || c.env.GEMINI_API_KEY),
      openrouter: Boolean(c.env.OPENROUTER_API_KEYS || c.env.OPENROUTER_API_KEY),
      apinex: Boolean(c.env.APINEX_API_KEYS || c.env.APINEX_API_KEY),
      customAi: Boolean(
        (c.env.CUSTOM_AI_API_KEYS || c.env.CUSTOM_AI_API_KEY) && c.env.CUSTOM_AI_BASE_URL
      ),
      tavily: Boolean(c.env.TAVILY_API_KEY),
      googleOAuth: Boolean(
        c.env.GOOGLE_OAUTH_CLIENT_ID &&
          c.env.GOOGLE_OAUTH_CLIENT_SECRET &&
          c.env.GOOGLE_OAUTH_REFRESH_TOKEN
      ),
      bloggerDefaultId: Boolean(c.env.DEFAULT_BLOGGER_BLOG_ID),
      searchConsole: Boolean(c.env.GSC_SITE_URL),
      ga4: Boolean(c.env.GA4_PROPERTY_ID),
      adsterra: Boolean(c.env.ADSTERRA_API_KEY),
      fcmServiceAccount: Boolean(c.env.FCM_SERVICE_ACCOUNT_JSON),
    },
    agentState,
    aiProviders,
  });
});

export default healthRoutes;
