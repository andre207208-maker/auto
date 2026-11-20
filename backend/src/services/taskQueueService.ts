import {
  claimTaskAtomically,
  completeTaskRow,
  failOrRetryTaskRow,
  getTaskQueueStats,
  getTaskRowById,
  insertTaskIfNew,
  listDueTaskRows,
  listTaskRows,
  releaseExpiredTaskLocks,
} from '../db/repositories.js';
import {
  PersistentTask,
  TaskQueueStats,
  TaskStatus,
  TaskStatusFilter,
  TaskType,
  WorkerEnv,
} from '../types/index.js';

export async function enqueueTask<T extends Record<string, unknown>>(
  env: WorkerEnv,
  params: {
    type: TaskType;
    payload: T;
    createdBy: string;
    idempotencyKey?: string;
    maxAttempts?: number;
    delaySeconds?: number;
    priority?: number;
  }
): Promise<{
  task: PersistentTask<T>;
  duplicate: boolean;
  dispatchedToQueue: boolean;
  queueBackend: 'd1';
}> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const candidate: PersistentTask<T> = {
    id,
    idempotencyKey: params.idempotencyKey ?? null,
    type: params.type,
    payload: params.payload,
    status: 'queued',
    priority: params.priority ?? 5,
    attempts: 0,
    maxAttempts: params.maxAttempts ?? 4,
    nextRetryAt: params.delaySeconds
      ? new Date(Date.now() + params.delaySeconds * 1000).toISOString()
      : null,
    lockedAt: null,
    lockedBy: null,
    lockExpiresAt: null,
    startedAt: null,
    lastError: null,
    result: null,
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };

  const { task, duplicate } = await insertTaskIfNew(env.DB, candidate);
  return {
    task: task as PersistentTask<T>,
    duplicate,
    dispatchedToQueue: false,
    queueBackend: 'd1',
  };
}

export async function getTaskById(env: WorkerEnv, taskId: string): Promise<PersistentTask | null> {
  return getTaskRowById(env.DB, taskId);
}

export async function listTasks(
  env: WorkerEnv,
  options?: { status?: TaskStatusFilter; limit?: number }
): Promise<PersistentTask[]> {
  return listTaskRows(env.DB, options);
}

export async function getQueueStats(env: WorkerEnv): Promise<TaskQueueStats> {
  return getTaskQueueStats(env.DB);
}

export async function claimTask(
  env: WorkerEnv,
  taskId: string,
  workerId = 'd1-cron-worker',
  lockTtlSeconds = 120
): Promise<PersistentTask | null> {
  return claimTaskAtomically(env.DB, taskId, workerId, lockTtlSeconds);
}

export async function releaseExpiredLocks(env: WorkerEnv): Promise<number> {
  return releaseExpiredTaskLocks(env.DB);
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

export async function listDueRetryTasks(env: WorkerEnv, limit = 3): Promise<PersistentTask[]> {
  return listDueTaskRows(env.DB, limit);
}
