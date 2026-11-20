import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';
import { checkAndIncrementRateLimit } from './db/repositories.js';
import { AppVariables } from './middleware/auth.js';
import healthRoutes from './routes/healthRoutes.js';
import apiRouter from './routes/index.js';
import { QueueTaskMessage, WorkerEnv } from './types/index.js';
import { AppError } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { handleQueueBatch, handleScheduledCron } from './workers/taskWorker.js';

export function createApp(): Hono<{ Bindings: WorkerEnv; Variables: AppVariables }> {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  // Request ID, security headers, and structured timing log
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');

    const started = Date.now();
    await next();

    if (c.req.path !== '/health') {
      logger.info('Worker request completed', {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - started,
      });
    }
  });

  // Dynamic CORS supporting Android app & web console
  app.use('*', async (c, next) => {
    const allowedRaw = c.env.CORS_ALLOWED_ORIGINS || '*';
    const allowedList = allowedRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const corsMiddleware = cors({
      origin: (origin) => {
        if (allowedList.includes('*') || !origin) {
          return origin || '*';
        }
        return allowedList.includes(origin) ? origin : '';
      },
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-API-Key',
        'X-Scheduler-Secret',
        'X-Request-Id',
        'X-Media-Key',
      ],
      maxAge: 86400,
    });

    return corsMiddleware(c, next);
  });

  // D1-backed edge sliding-window rate limiter on /api/v1/* (120 req/min per client IP)
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return next();
    }
    const clientIp =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown';
    const bucketKey = `api:${clientIp}`;
    const maxRequests = 120;
    const windowMs = 60_000;

    const rl = await checkAndIncrementRateLimit(c.env.DB, bucketKey, maxRequests, windowMs);
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(rl.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(rl.resetAt / 1000)));

    if (!rl.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        {
          error: 'Rate limit exceeded. Please retry shortly.',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: retryAfterSec,
          requestId: c.get('requestId'),
        },
        429
      );
    }

    return next();
  });

  app.get('/', (c) => {
    return c.json({
      service: c.env.SERVICE_NAME || 'autoblogger-ai',
      status: 'online',
      platform: 'cloudflare-workers',
      runtime: 'cloudflare-workers',
      healthEndpoint: '/health',
      apiBase: '/api/v1',
    });
  });

  app.route('/', healthRoutes);
  app.route('/api/v1', apiRouter);

  app.notFound((c) => {
    return c.json(
      {
        error: 'Route not found',
        code: 'NOT_FOUND',
        path: c.req.path,
        requestId: c.get('requestId'),
      },
      404
    );
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId');

    if (err instanceof ZodError) {
      return c.json(
        {
          error: 'Request validation failed',
          code: 'VALIDATION_ERROR',
          issues: err.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          requestId,
        },
        400
      );
    }

    if (err instanceof AppError) {
      logger.warn('Application error', {
        requestId,
        code: err.code,
        statusCode: err.statusCode,
        message: err.message,
      });

      return c.json(
        {
          error: err.message,
          code: err.code,
          ...(err.details ? { details: err.details } : {}),
          requestId,
        },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 423 | 429 | 500 | 502 | 503
      );
    }

    const message = err instanceof Error ? err.message : 'Unexpected server error';
    logger.error('Unhandled Worker error', {
      requestId,
      path: c.req.path,
      error: message,
    });

    return c.json(
      {
        error: message,
        code: 'INTERNAL_SERVER_ERROR',
        requestId,
      },
      500
    );
  });

  return app;
}

const app = createApp();

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> | Response {
    return app.fetch(request, env, ctx);
  },

  async queue(
    batch: MessageBatch<QueueTaskMessage>,
    env: WorkerEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    await handleQueueBatch(batch, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(handleScheduledCron(controller, env));
  },
};
