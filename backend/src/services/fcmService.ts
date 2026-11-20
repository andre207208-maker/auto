import { getDb } from '../config/firebase.js';
import { getFcm } from '../config/firebase.js';
import { logger } from '../utils/logger.js';

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  topic?: string;
}

const DEFAULT_TOPIC = 'autoblogger_alerts';

export async function registerDeviceToken(params: {
  token: string;
  uid: string;
  deviceName?: string;
  platform?: string;
}): Promise<void> {
  const db = getDb();
  const docId = Buffer.from(params.token).toString('base64url').slice(0, 120);

  await db.collection('device_tokens').doc(docId).set(
    {
      token: params.token,
      uid: params.uid,
      deviceName: params.deviceName || 'Android Device',
      platform: params.platform || 'android',
      active: true,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  // Also subscribe token to alert topic for broadcast notifications
  try {
    await getFcm().subscribeToTopic([params.token], DEFAULT_TOPIC);
  } catch (err) {
    logger.warn('Failed to subscribe device token to FCM topic', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function unregisterDeviceToken(token: string): Promise<void> {
  const db = getDb();
  const docId = Buffer.from(token).toString('base64url').slice(0, 120);
  await db.collection('device_tokens').doc(docId).delete();

  try {
    await getFcm().unsubscribeFromTopic([token], DEFAULT_TOPIC);
  } catch {
    // Ignore unsubscribe errors for stale tokens
  }
}

export async function sendNotification(payload: NotificationPayload): Promise<{
  topicSent: boolean;
  devicesTargeted: number;
  successCount: number;
  failureCount: number;
}> {
  const messaging = getFcm();
  const db = getDb();
  const topic = payload.topic || DEFAULT_TOPIC;

  let topicSent = false;
  try {
    await messaging.send({
      topic,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data,
      android: {
        priority: 'high',
      },
    });
    topicSent = true;
  } catch (err) {
    logger.warn('FCM topic send failed', {
      topic,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const tokensSnap = await db.collection('device_tokens').where('active', '==', true).limit(500).get();
  const tokens = tokensSnap.docs
    .map((d) => d.data().token as string)
    .filter((t) => typeof t === 'string' && t.length > 0);

  if (tokens.length === 0) {
    return { topicSent, devicesTargeted: 0, successCount: 0, failureCount: 0 };
  }

  const batchResp = await messaging.sendEachForMulticast({
    tokens,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data,
    android: {
      priority: 'high',
    },
  });

  // Deactivate invalid tokens automatically
  const cleanupPromises: Promise<unknown>[] = [];
  batchResp.responses.forEach((resp, idx) => {
    if (!resp.success && resp.error?.code === 'messaging/registration-token-not-registered') {
      const badDoc = tokensSnap.docs[idx];
      if (badDoc) {
        cleanupPromises.push(badDoc.ref.update({ active: false, updatedAt: new Date().toISOString() }));
      }
    }
  });
  await Promise.allSettled(cleanupPromises);

  return {
    topicSent,
    devicesTargeted: tokens.length,
    successCount: batchResp.successCount,
    failureCount: batchResp.failureCount,
  };
}
