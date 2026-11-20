import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'http';
import { assertStrictEnvironment, env } from './config/env.js';
import { initializeFirebaseAdmin } from './config/firebase.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { requestLogger } from './middleware/requestLogger.js';
import healthRoutes from './routes/healthRoutes.js';
import apiRouter from './routes/index.js';
import { logger } from './utils/logger.js';

assertStrictEnvironment();
initializeFirebaseAdmin();

const app = express();

// Cloud Run sits behind Google's HTTPS load balancer
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGINS_LIST.includes('*') ? true : env.CORS_ORIGINS_LIST,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Scheduler-Secret', 'X-Request-Id'],
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(requestLogger);

// Rate limiting on API routes (never rate-limit /health probes)
app.use('/api/v1', createRateLimiter({ windowMs: 60_000, maxRequests: 120 }));

app.get('/', (_req, res) => {
  res.json({
    service: env.SERVICE_NAME,
    status: 'online',
    healthEndpoint: '/health',
    apiBase: '/api/v1',
  });
});

app.use(healthRoutes);
app.use('/api/v1', apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const server: Server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info('AUTOBLOGGER AI backend listening', {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    service: env.SERVICE_NAME,
  });
});

let shuttingDown = false;

function gracefulShutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown`);

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close((err) => {
    if (err) {
      logger.error('Error closing HTTP server', { error: err.message });
      process.exit(1);
    }
    logger.info('HTTP server closed cleanly');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
