import { WorkerEnv } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  topic?: string;
}

const DEFAULT_TOPIC = 'autoblogger_alerts';

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getFcmAccessToken(serviceAccountJson: string): Promise<{
  accessToken: string;
  projectId: string;
}> {
  const sa = JSON.parse(serviceAccountJson) as {
    client_email: string;
    private_key: string;
    project_id: string;
  };

  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      })
    )
  );

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signingInput = new TextEncoder().encode(`${header}.${claim}`);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, signingInput.buffer as ArrayBuffer);
  const jwt = `${header}.${claim}.${encodeBase64Url(new Uint8Array(sig))}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`FCM OAuth token exchange failed (${tokenRes.status}): ${errText}`);
  }

  const data = (await tokenRes.json()) as { access_token: string };
  return { accessToken: data.access_token, projectId: sa.project_id };
}

export async function registerDeviceToken(
  env: WorkerEnv,
  params: { token: string; uid: string; deviceName?: string; platform?: string }
): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO device_tokens (id, token, uid, device_name, platform, active, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(token) DO UPDATE SET
       uid = excluded.uid,
       device_name = excluded.device_name,
       platform = excluded.platform,
       active = 1,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      params.token,
      params.uid,
      params.deviceName || 'Android Device',
      params.platform || 'android',
      now
    )
    .run();
}

export async function unregisterDeviceToken(env: WorkerEnv, token: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM device_tokens WHERE token = ?`).bind(token).run();
}

export async function listNotifications(
  env: WorkerEnv,
  limit = 30
): Promise<Array<Record<string, unknown>>> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const res = await env.DB.prepare(
    `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`
  )
    .bind(safeLimit)
    .all<Record<string, unknown>>();
  return res.results;
}

export async function sendNotification(
  env: WorkerEnv,
  payload: NotificationPayload
): Promise<{
  notificationId: string;
  fcmDispatched: boolean;
  devicesTargeted: number;
  successCount: number;
  failureCount: number;
}> {
  const notificationId = crypto.randomUUID();
  const topic = payload.topic || DEFAULT_TOPIC;
  const now = new Date().toISOString();

  const tokensRes = await env.DB.prepare(
    `SELECT id, token FROM device_tokens WHERE active = 1 LIMIT 100`
  ).all<{ id: string; token: string }>();

  const tokens = tokensRes.results;
  let fcmDispatched = false;
  let successCount = 0;
  let failureCount = 0;

  if (env.FCM_SERVICE_ACCOUNT_JSON?.trim()) {
    try {
      const { accessToken, projectId } = await getFcmAccessToken(env.FCM_SERVICE_ACCOUNT_JSON);
      const endpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

      // Send topic broadcast
      const topicRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            topic,
            notification: { title: payload.title, body: payload.body },
            data: payload.data,
            android: { priority: 'HIGH' },
          },
        }),
      });
      if (topicRes.ok) {
        fcmDispatched = true;
      }

      // Send to individual registered Android tokens
      for (const device of tokens) {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: device.token,
              notification: { title: payload.title, body: payload.body },
              data: payload.data,
              android: { priority: 'HIGH' },
            },
          }),
        });

        if (res.ok) {
          successCount += 1;
          fcmDispatched = true;
        } else {
          failureCount += 1;
          if (res.status === 404 || res.status === 410) {
            await env.DB.prepare(`UPDATE device_tokens SET active = 0, updated_at = ? WHERE id = ?`)
              .bind(now, device.id)
              .run();
          }
        }
      }
    } catch (err) {
      logger.warn('FCM HTTP v1 delivery failed; notification saved in D1 inbox', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await env.DB.prepare(
    `INSERT INTO notifications (
       id, title, body, topic, data_json, fcm_dispatched, devices_targeted, success_count, failure_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      notificationId,
      payload.title,
      payload.body,
      topic,
      payload.data ? JSON.stringify(payload.data) : null,
      fcmDispatched ? 1 : 0,
      tokens.length,
      successCount,
      failureCount,
      now
    )
    .run();

  return {
    notificationId,
    fcmDispatched,
    devicesTargeted: tokens.length,
    successCount,
    failureCount,
  };
}
