import { Context, Next } from 'hono';
import { AuthenticatedPrincipal, WorkerEnv } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface AppVariables {
  principal?: AuthenticatedPrincipal;
  requestId: string;
}

export type AppContext = Context<{ Bindings: WorkerEnv; Variables: AppVariables }>;

interface JwkKey {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

let cachedJwks: { keys: JwkKey[]; expiresAt: number } | null = null;

function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64UrlToUint8Array(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function fetchFirebasePublicKeys(): Promise<JwkKey[]> {
  if (cachedJwks && cachedJwks.expiresAt > Date.now()) {
    return cachedJwks.keys;
  }

  const response = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch Firebase JWKS (${response.status})`);
  }

  const data = (await response.json()) as { keys: JwkKey[] };
  cachedJwks = {
    keys: data.keys || [],
    expiresAt: Date.now() + 3600_000,
  };
  return cachedJwks.keys;
}

async function verifyFirebaseIdToken(
  token: string,
  projectId: string
): Promise<{ uid: string; email?: string; roles: string[] }> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(headerB64))) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(payloadB64))) as {
    iss?: string;
    aud?: string;
    sub?: string;
    email?: string;
    exp?: number;
    iat?: number;
    roles?: string[];
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported JWT algorithm or missing kid');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Firebase ID token expired');
  }
  if (!payload.sub) {
    throw new Error('Token missing subject');
  }
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Token audience or issuer mismatch');
  }

  const keys = await fetchFirebasePublicKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new Error('Matching Firebase public key not found');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToUint8Array(signatureB64);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature.buffer as ArrayBuffer,
    signingInput.buffer as ArrayBuffer
  );

  if (!valid) {
    throw new Error('Invalid Firebase ID token signature');
  }

  return {
    uid: payload.sub,
    email: payload.email,
    roles: Array.isArray(payload.roles) ? payload.roles : ['user'],
  };
}

export async function requireAuth(c: AppContext, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('authorization');
  const apiKeyHeader = c.req.header('x-api-key');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      return c.json({ error: 'Empty Bearer token' }, 401);
    }

    const projectId = c.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      return c.json(
        { error: 'FIREBASE_PROJECT_ID must be configured to verify Firebase Bearer tokens' },
        503
      );
    }

    try {
      const verified = await verifyFirebaseIdToken(token, projectId);
      c.set('principal', {
        uid: verified.uid,
        email: verified.email,
        authMethod: 'firebase_id_token',
        roles: verified.roles,
      });
      await next();
      return;
    } catch (err) {
      logger.warn('Firebase token verification failed', {
        path: c.req.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'Invalid or expired Firebase ID token' }, 401);
    }
  }

  const allowApiKey = (c.env.ALLOW_API_KEY_AUTH ?? 'true') === 'true';
  if (allowApiKey && apiKeyHeader) {
    const secret = c.env.BACKEND_API_SECRET || '';
    if (!secret) {
      return c.json({ error: 'BACKEND_API_SECRET is not configured on the Worker' }, 503);
    }

    if (constantTimeEqual(apiKeyHeader, secret)) {
      c.set('principal', {
        uid: 'api-key-client',
        authMethod: 'api_key',
        roles: ['admin'],
      });
      await next();
      return;
    }

    return c.json({ error: 'Invalid API key' }, 403);
  }

  return c.json(
    {
      error:
        'Authentication required. Provide Authorization: Bearer <Firebase ID Token> or X-API-Key header.',
    },
    401
  );
}

export async function requireSchedulerOrAuth(c: AppContext, next: Next): Promise<Response | void> {
  const schedulerSecret = c.req.header('x-scheduler-secret');
  const expected = c.env.SCHEDULER_SHARED_SECRET || '';

  if (schedulerSecret && expected) {
    if (constantTimeEqual(schedulerSecret, expected)) {
      c.set('principal', {
        uid: 'scheduler-client',
        authMethod: 'scheduler_secret',
        roles: ['system', 'scheduler'],
      });
      await next();
      return;
    }
    return c.json({ error: 'Invalid scheduler secret' }, 403);
  }

  return requireAuth(c, next);
}
