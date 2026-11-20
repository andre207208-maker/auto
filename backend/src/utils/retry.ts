import { logger } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  operationName?: string;
  shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 400,
    maxDelayMs = 8000,
    operationName = 'operation',
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const canRetry = attempt < maxAttempts && shouldRetry(err);
      if (!canRetry) {
        break;
      }

      const jitter = Math.floor(Math.random() * 150);
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1) + jitter);

      logger.warn(`${operationName} failed on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`, {
        error: err instanceof Error ? err.message : String(err),
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}
