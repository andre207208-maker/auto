import { Router } from 'express';
import { env, getEnvDiagnostics } from '../config/env.js';
import { getFirebaseStatus } from '../config/firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getAgentState } from '../services/agentControlService.js';
import { aiProviderManager } from '../services/aiProviderManager.js';

const router = Router();

router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const firebase = getFirebaseStatus();
    let agentStatus = 'unknown';

    if (firebase.initialized) {
      try {
        const state = await getAgentState();
        agentStatus = state.status;
      } catch {
        agentStatus = 'unavailable';
      }
    }

    res.status(200).json({
      status: 'ok',
      service: env.SERVICE_NAME,
      version: '1.0.0',
      environment: env.NODE_ENV,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      firebaseConnected: firebase.initialized,
      agentStatus,
    });
  })
);

router.get(
  '/api/v1/health/detailed',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const firebase = getFirebaseStatus();
    const envReport = getEnvDiagnostics();
    const providers = aiProviderManager.getProvidersHealth();
    const agentState = firebase.initialized ? await getAgentState() : null;

    res.json({
      status: 'ok',
      service: env.SERVICE_NAME,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      firebase,
      agentState,
      envDiagnostics: envReport,
      aiProviders: providers,
    });
  })
);

export default router;
