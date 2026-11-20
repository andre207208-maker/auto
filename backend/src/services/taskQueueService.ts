import {
  claimTaskAtomically,
  completeTaskRow,
  failOrRetryTaskRow,
  getTaskRowById,
  insertTaskIfNew,
  listDueTaskRows,
  listTaskRows,
} from '../db/repositories.js';
import { PersistentTask, TaskStatus, TaskType, WorkerEnv } from '../types/index.js';
import { logger } from '../utils/logger.js';

export async function enqueueTask<T extends Record<string, unknown>>(
  env: WorkerEnv,
  params: {
    type: TaskType;
    payload: T;
    createdBy: string;
    idempotencyKey?: string;
    maxAttempts?: number;
    delaySeconds?: number;
  }
): Promise<{ task: PersistentTask<T>; duplicate: boolean; dispatchedToQueue: boolean }> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const candidate: PersistentTask<T> = {
    id,
    idempotencyKey: params.idempotencyKey ?? null,
    type: params.type,
    payload: params.payload,
    status: 'queued',
    attempts: 0,
    maxAttempts: params.maxAttempts ?? 4,
    nextRetryAt: params.delaySeconds
      ? new Date(Date.now() + params.delaySeconds * 1000).toISOString()
      : null,
    lastError: null,
    result: null,
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };

  const { task, duplicate } = await insertTaskIfNew(env.DB, candidate);
  if (duplicate) {
    return {
      task: task as PersistentTask<T>,
      duplicate: true,
      dispatchedToQueue: false,
    };
  }

  let dispatchedToQueue = false;
  if (env.TASK_QUEUE) {
    try {
      await env.TASK_QUEUE.send(
        {
          taskId: task.id,
          type: task.type,
          enqueuedAt: now,
        },
        params.delaySeconds ? { delaySeconds: params.delaySeconds } : undefined
      );
      dispatchedToQueue = true;
    } catch (err) {
      logger.warn('Cloudflare Queue send failed; task remains persisted in D1 for cron retry sweep', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    task: task as PersistentTask<T>,
    duplicate: false,
    dispatchedToQueue,
  };
}

export async function getTaskById(env: WorkerEnv, taskId: string): Promise<PersistentTask | null> {
  return getTaskRowById(env.DB, taskId);
}

export async function listTasks(
  env: WorkerEnv,
  options?: { status?: TaskStatus; limit?: number }
): Promise<PersistentTask[]> {
  return listTaskRows(env.DB, options);
}

export async function claimTask(env: WorkerEnv, taskId: string): Promise<PersistentTask | null> {
  return claimTaskAtomically(env.DB, taskId);
}

export async function completeTask(
  env: WorkerEnv,
  taskId: string,
  result: Record<string, unknown>
): Promise<void> {
  await completeTaskRow(env.DB, taskId, result);
}

export async function failOrRetryTask(
  env: WorkerEnv,
  task: PersistentTask,
  error: unknown
): Promise<{ status: TaskStatus; delaySeconds: number; message: string }> {
  const message = error instanceof Error ? error.message : String(error);
  const outcome = await failOrRetryTaskRow(env.DB, task, message);
  return { ...outcome, message };
}

export async function listDueRetryTasks(env: WorkerEnv, limit = 15): Promise<PersistentTask[]> {
  return listDueTaskRows(env.DB, limit);
}
