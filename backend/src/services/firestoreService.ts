import { getDb, getFirebaseStatus } from '../config/firebase.js';
import { logger } from '../utils/logger.js';

export const COLLECTIONS = {
  SYSTEM_STATE: 'system_state',
  CAMPAIGNS: 'campaigns',
  POSTS: 'posts',
  TASK_QUEUE: 'task_queue',
  AD_CONFIGS: 'ad_configs',
  ANALYTICS_SNAPSHOTS: 'analytics_snapshots',
  DEVICE_TOKENS: 'device_tokens',
  AI_PROVIDER_HEALTH: 'ai_provider_health',
  SYSTEM_LOGS: 'system_logs',
  AI_PROVIDER_SETTINGS: 'ai_provider_settings',
} as const;

export async function logSystemEvent(
  level: 'info' | 'warn' | 'error' | 'critical',
  category: string,
  message: string,
  details?: Record<string, unknown>
): Promise<void> {
  const fb = getFirebaseStatus();
  if (!fb.initialized) {
    return;
  }

  try {
    const db = getDb();
    await db.collection(COLLECTIONS.SYSTEM_LOGS).add({
      level,
      category,
      message,
      details: details || null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('Failed to persist system event to Firestore', {
      category,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function listRecentSystemLogs(limit = 50): Promise<Array<Record<string, unknown>>> {
  const db = getDb();
  const snapshot = await db
    .collection(COLLECTIONS.SYSTEM_LOGS)
    .orderBy('createdAt', 'desc')
    .limit(Math.min(limit, 200))
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
