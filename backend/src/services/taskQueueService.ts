import crypto from 'crypto';
import { CloudTasksClient } from '@google-cloud/tasks';
import { env } from '../config/env.js';
import { getDb } from '../config/firebase.js';
import { PersistentTask, TaskStatus, TaskType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { COLLECTIONS } from './firestoreService.js';

let cloudTasksClient: CloudTasksClient | null = null;

function getCloudTasksClient(): CloudTasksClient {
  if (!cloudTasksClient) {
    cloudTasksClient = new CloudTasksClient();
  }
  return cloudTasksClient;
}

export async function enqueueTask<T extends Record<string, unknown>>(params: {
  type: TaskType;
  payload: T;
  createdBy: string;
  maxAttempts?: number;
  delaySeconds?: number;
}): Promise<PersistentTask<T>> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const task: PersistentTask<T> = {
    id,
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
    cloudTaskName: null,
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };

  await db.collection(COLLECTIONS.TASK_QUEUE).doc(id).set(task);

  if (env.CLOUD_TASKS_ENABLED && env.CLOUD_RUN_SERVICE_URL) {
    try {
      const project = env.GOOGLE_CLOUD_PROJECT || env.FIREBASE_PROJECT_ID;
      if (!project) {
        throw new Error('GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID must be set for Cloud Tasks');
      }

      const client = getCloudTasksClient();
      const parent = client.queuePath(project, env.CLOUD_TASKS_LOCATION, env.CLOUD_TASKS_QUEUE);
      const targetUrl = `${env.CLOUD_RUN_SERVICE_URL.replace(/\/+$/, '')}/api/v1/tasks/execute`;

      const [created] = await client.createTask({
        parent,
        task: {
          httpRequest: {
            httpMethod: 'POST',
            url: targetUrl,
            headers: {
              'Content-Type': 'application/json',
              ...(env.SCHEDULER_SHARED_SECRET
                ? { 'X-Scheduler-Secret': env.SCHEDULER_SHARED_SECRET }
                : {}),
            },
            body: Buffer.from(JSON.stringify({ taskId: id })).toString('base64'),
            ...(env.CLOUD_TASKS_INVOKER_SA_EMAIL
              ? {
                  oidcToken: {
                    serviceAccountEmail: env.CLOUD_TASKS_INVOKER_SA_EMAIL,
                    audience: env.CLOUD_RUN_SERVICE_URL,
                  },
                }
              : {}),
          },
          ...(params.delaySeconds
            ? {
                scheduleTime: {
                  seconds: Math.floor(Date.now() / 1000) + params.delaySeconds,
                },
              }
            : {}),
        },
      });

      task.cloudTaskName = created.name || null;
      await db.collection(COLLECTIONS.TASK_QUEUE).doc(id).update({
        cloudTaskName: task.cloudTaskName,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('Cloud Tasks dispatch failed; task remains persisted in Firestore for worker/retry execution', {
        taskId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return task;
}

export async function getTaskById(taskId: string): Promise<PersistentTask | null> {
  const doc = await getDb().collection(COLLECTIONS.TASK_QUEUE).doc(taskId).get();
  if (!doc.exists) {
    return null;
  }
  return doc.data() as PersistentTask;
}

export async function listTasks(options?: {
  status?: TaskStatus;
  limit?: number;
}): Promise<PersistentTask[]> {
  const db = getDb();
  let query = db.collection(COLLECTIONS.TASK_QUEUE).orderBy('createdAt', 'desc');
  if (options?.status) {
    query = db
      .collection(COLLECTIONS.TASK_QUEUE)
      .where('status', '==', options.status)
      .orderBy('createdAt', 'desc');
  }
  const snap = await query.limit(Math.min(options?.limit || 50, 200)).get();
  return snap.docs.map((d) => d.data() as PersistentTask);
}

export async function markTaskProcessing(taskId: string): Promise<PersistentTask | null> {
  const db = getDb();
  const docRef = db.collection(COLLECTIONS.TASK_QUEUE).doc(taskId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      return null;
    }
    const task = snap.data() as PersistentTask;
    if (task.status === 'completed' || task.status === 'cancelled') {
      return null;
    }

    const updated: PersistentTask = {
      ...task,
      status: 'processing',
      attempts: task.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    tx.set(docRef, updated);
    return updated;
  });
}

export async function markTaskCompleted(
  taskId: string,
  result: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();
  await getDb().collection(COLLECTIONS.TASK_QUEUE).doc(taskId).update({
    status: 'completed',
    result,
    lastError: null,
    nextRetryAt: null,
    completedAt: now,
    updatedAt: now,
  });
}

export async function markTaskFailedOrRetry(task: PersistentTask, error: unknown): Promise<PersistentTask> {
  const db = getDb();
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date();
  const exhausted = task.attempts >= task.maxAttempts;

  if (exhausted) {
    const updated: PersistentTask = {
      ...task,
      status: 'dead_letter',
      lastError: message,
      nextRetryAt: null,
      updatedAt: now.toISOString(),
    };
    await db.collection(COLLECTIONS.TASK_QUEUE).doc(task.id).set(updated);
    return updated;
  }

  // Exponential backoff in seconds: 30s, 120s, 480s, ...
  const delaySeconds = Math.min(3600, 30 * Math.pow(4, Math.max(0, task.attempts - 1)));
  const nextRetryAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();

  const updated: PersistentTask = {
    ...task,
    status: 'retrying',
    lastError: message,
    nextRetryAt,
    updatedAt: now.toISOString(),
  };
  await db.collection(COLLECTIONS.TASK_QUEUE).doc(task.id).set(updated);
  return updated;
}

export async function listDueRetryTasks(limit = 20): Promise<PersistentTask[]> {
  const nowIso = new Date().toISOString();
  const snap = await getDb()
    .collection(COLLECTIONS.TASK_QUEUE)
    .where('status', 'in', ['queued', 'retrying'])
    .limit(100)
    .get();

  return snap.docs
    .map((d) => d.data() as PersistentTask)
    .filter((t) => !t.nextRetryAt || t.nextRetryAt <= nowIso)
    .slice(0, limit);
}
