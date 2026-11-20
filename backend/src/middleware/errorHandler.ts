import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Route not found',
    code: 'NOT_FOUND',
    path: req.originalUrl,
    requestId: req.requestId,
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Request validation failed',
      code: 'VALIDATION_ERROR',
      issues: err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
      requestId: req.requestId,
    });
    return;
  }

  if (err instanceof AppError) {
    logger.warn('Application error', {
      requestId: req.requestId,
      code: err.code,
      statusCode: err.statusCode,
      message: err.message,
      path: req.originalUrl,
    });

    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.details ? { details: err.details } : {}),
      requestId: req.requestId,
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Unexpected server error';
  logger.error('Unhandled server error', {
    requestId: req.requestId,
    path: req.originalUrl,
    method: req.method,
    error: message,
    stack: err instanceof Error ? err.stack : undefined,
  });

  res.status(500).json({
    error: message,
    code: 'INTERNAL_SERVER_ERROR',
    requestId: req.requestId,
  });
}
