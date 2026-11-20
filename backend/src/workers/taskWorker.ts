import { AppError } from '../middleware/errorHandler.js';
import { sendNotification } from '../services/fcmService.js';
import { logSystemEvent } from '../services/firestoreService.js';
import { researchTopic } from '../services/researchService.js';
import { inspectUrl } from '../services/searchConsoleService.js';
import {
  listDueRetryTasks,
  markTaskCompleted,
  markTaskFailedOrRetry,
  markTaskProcessing,
} from '../services/taskQueueService.js';
import { PersistentTask } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { runAnalyticsSyncJob } from './analyticsWorker.js';
import { PublishPipelineInput, runAutonomousPublishPipeline } from './publishWorker.js';

export async function executeTaskById(taskId: string): Promise<{
  taskId: string;
  status: string;
  result?: Record<string, unknown>;
  error?: string;
}> {
  const claimed = await markTaskProcessing(taskId);
  if (!claimed) {
    return { taskId, status: 'skipped_or_missing' };
  }

  try {
    let result: Record<string, unknown>;

    switch (claimed.type) {
      case 'GENERATE_AND_PUBLISH': {
        const output = await runAutonomousPublishPipeline(
          claimed.payload as unknown as PublishPipelineInput
        );
        result = output as unknown as Record<string, unknown>;
        break;
      }
      case 'RESEARCH_TOPIC': {
        const res = await researchTopic(
          claimed.payload as {
            niche: string;
            seedKeyword?: string;
            language?: string;
            targetAudience?: string;
          }
        );
        result = res as unknown as Record<string, unknown>;
        break;
      }
      case 'SYNC_ANALYTICS_DAILY': {
        result = await runAnalyticsSyncJob('daily');
        break;
      }
      case 'SYNC_ANALYTICS_WEEKLY': {
        result = await runAnalyticsSyncJob('weekly');
        break;
      }
      case 'SEND_NOTIFICATION': {
        result = await sendNotification(
          claimed.payload as { title: string; body: string; data?: Record<string, string> }
        );
        break;
      }
      case 'INDEX_URL_CHECK': {
        const payload = claimed.payload as { inspectionUrl: string; siteUrl?: string };
        const inspection = await inspectUrl(payload.inspectionUrl, payload.siteUrl);
        result = { inspection };
        break;
      }
      default:
        throw new AppError(`Unsupported task type: ${String(claimed.type)}`, 400, 'UNSUPPORTED_TASK_TYPE');
    }

    await markTaskCompleted(claimed.id, result);
    return { taskId: claimed.id, status: 'completed', result };
  } catch (err) {
    const updated = await markTaskFailedOrRetry(claimed, err);
    const message = err instanceof Error ? err.message : String(err);

    logger.error('Task execution failed', {
      taskId: claimed.id,
      type: claimed.type,
      attempts: claimed.attempts,
      nextStatus: updated.status,
      error: message,
    });

    await logSystemEvent('error', 'task_worker', `Task ${claimed.id} (${claimed.type}) failed`, {
      attempts: claimed.attempts,
      nextStatus: updated.status,
      error: message,
    });

    if (updated.status === 'dead_letter') {
      try {
        await sendNotification({
          title: 'AUTOBLOGGER Task Dead-Letter Alert',
          body: `Task ${claimed.type} failed permanently after ${updated.attempts} attempts.`,
          data: { event: 'task_dead_letter', taskId: updated.id },
        });
      } catch {
        // Non-fatal
      }
    }

    return { taskId: claimed.id, status: updated.status, error: message };
  }
}

export async function processDueRetryQueue(limit = 15): Promise<{
  processed: number;
  outcomes: Array<{ taskId: string; status: string; error?: string }>;
}> {
  const dueTasks: PersistentTask[] = await listDueRetryTasks(limit);
  const outcomes: Array<{ taskId: string; status: string; error?: string }> = [];

  for (const task of dueTasks) {
    const outcome = await executeTaskById(task.id);
    outcomes.push(outcome);
  }

  return {
    processed: outcomes.length,
    outcomes,
  };
}
