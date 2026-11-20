import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { getFirebaseAuth } from '../config/firebase.js';
import { AuthenticatedPrincipal } from '../types/index.js';
import { logger } from '../utils/logger.js';

declare global {
  namespace Express {
    interface Request {
      principal?: AuthenticatedPrincipal;
      requestId?: string;
    }
  }
}

function constantTimeMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.header('x-api-key');

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim();
      if (!token) {
        res.status(401).json({ error: 'Empty Bearer token' });
        return;
      }

      const decoded = await getFirebaseAuth().verifyIdToken(token);
      req.principal = {
        uid: decoded.uid,
        email: decoded.email,
        authMethod: 'firebase_id_token',
        roles: Array.isArray(decoded.roles) ? decoded.roles : ['user'],
      };
      next();
      return;
    }

    if (env.ALLOW_API_KEY_AUTH && apiKeyHeader) {
      if (!env.BACKEND_API_SECRET) {
        res.status(503).json({
          error: 'BACKEND_API_SECRET is not configured on the server',
        });
        return;
      }

      if (constantTimeMatch(apiKeyHeader, env.BACKEND_API_SECRET)) {
        req.principal = {
          uid: 'api-key-client',
          authMethod: 'api_key',
          roles: ['admin'],
        };
        next();
        return;
      }

      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    res.status(401).json({
      error: 'Authentication required. Provide Authorization: Bearer <Firebase ID Token> or X-API-Key header.',
    });
  } catch (err) {
    logger.warn('Authentication failed', {
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(401).json({ error: 'Invalid or expired authentication credentials' });
  }
}

export async function requireSchedulerOrAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const schedulerSecret = req.header('x-scheduler-secret');

  if (schedulerSecret && env.SCHEDULER_SHARED_SECRET) {
    if (constantTimeMatch(schedulerSecret, env.SCHEDULER_SHARED_SECRET)) {
      req.principal = {
        uid: 'cloud-scheduler-system',
        authMethod: 'cloud_scheduler',
        roles: ['system', 'scheduler'],
      };
      next();
      return;
    }
    res.status(403).json({ error: 'Invalid scheduler secret' });
    return;
  }

  // Fallback to standard user/API-key auth (e.g., manual trigger from Android app)
  await requireAuth(req, res, next);
}
