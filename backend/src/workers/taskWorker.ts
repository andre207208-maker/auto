import { logSystemEvent, updatePipelineRun } from '../db/repositories.js';
import { getAgentState } from '../services/agentControlService.js';
import { generateArticle } from '../services/contentGeneratorService.js';
import { sendNotification } from '../services/fcmService.js';
import { researchTopic } from '../services/researchService.js';
import { runSchedulerTick } from '../services/schedulerService.js';
import { inspectUrl } from '../services/searchConsoleService.js';
import {
  claimTask,
  completeTask,
  enqueueTask,
  failOrRetryTask,
  listDueRetryTasks,
} from '../services/taskQueueService.js';
import { QueueTaskMessage, WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { runAnalyticsSyncJob } from './analyticsWorker.js';
import {
  executePipelineGenerateStage,
  executePipelinePublishStage,
  executePipelineResearchStage,
  PublishPipelineInput,
  startAutonomousPipeline,
} from './publishWorker.js';

export async function executeTaskById(
  env: WorkerEnv,
  taskId: string
): Promise<{
  taskId: string;
  status: string;
  shouldRetryMessage?: boolean;
  delaySeconds?: number;
  result?: Record<string, unknown>;
  error?: string;
}> {
  const claimed = await claimTask(env, taskId);
  if (!claimed) {
    return { taskId, status: 'skipped_or_already_claimed', shouldRetryMessage: false };
  }

  try {
    let result: Record<string, unknown>;

    switch (claimed.type) {
      case 'PIPELINE_RESEARCH': {
        const { pipelineId } = claimed.payload as { pipelineId: string };
        result = await executePipelineResearchStage(env, pipelineId);
        break;
      }
      case 'PIPELINE_GENERATE': {
        const { pipelineId } = claimed.payload as { pipelineId: string };
        result = await executePipelineGenerateStage(env, pipelineId);
        break;
      }
      case 'PIPELINE_OPTIMIZE_AND_PUBLISH': {
        const { pipelineId } = claimed.payload as { pipelineId: string };
        result = await executePipelinePublishStage(env, pipelineId);
        break;
      }
      case 'GENERATE_AND_PUBLISH': {
        const started = await startAutonomousPipeline(
          env,
          claimed.payload as unknown as PublishPipelineInput
        );
        result = {
          pipelineId: started.pipeline.id,
          initialTaskId: started.initialTaskId,
          stage: started.pipeline.stage,
        };
        break;
      }
      case 'RESEARCH_TOPIC': {
        const res = await researchTopic(
          env,
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
      case 'GENERATE_ARTICLE': {
        const article = await generateArticle(
          env,
          claimed.payload as {
            topic: string;
            primaryKeyword: string;
            secondaryKeywords?: string[];
            language?: string;
            tone?: string;
            targetWordCount?: number;
          }
        );
        result = article as unknown as Record<string, unknown>;
        break;
      }
      case 'SYNC_ANALYTICS_DAILY': {
        result = await runAnalyticsSyncJob(env, 'daily');
        break;
      }
      case 'SYNC_ANALYTICS_WEEKLY': {
        result = await runAnalyticsSyncJob(env, 'weekly');
        break;
      }
      case 'SEND_NOTIFICATION': {
        result = await sendNotification(
          env,
          claimed.payload as { title: string; body: string; data?: Record<string, string> }
        );
        break;
      }
      case 'INDEX_URL_CHECK': {
        const payload = claimed.payload as { inspectionUrl: string; siteUrl?: string };
        const inspection = await inspectUrl(env, payload.inspectionUrl, payload.siteUrl);
        result = { inspection };
        break;
      }
      default:
        throw new AppError(
          `Unsupported task type: ${String(claimed.type)}`,
          400,
          'UNSUPPORTED_TASK_TYPE'
        );
    }

    await completeTask(env, claimed.id, result);
    return { taskId: claimed.id, status: 'completed', shouldRetryMessage: false, result };
  } catch (err) {
    const failure = await failOrRetryTask(env, claimed, err);

    if (
      (claimed.type === 'PIPELINE_RESEARCH' ||
        claimed.type === 'PIPELINE_GENERATE' ||
        claimed.type === 'PIPELINE_OPTIMIZE_AND_PUBLISH') &&
      failure.status === 'dead_letter'
    ) {
      const pipelineId = (claimed.payload as { pipelineId?: string })?.pipelineId;
      if (pipelineId) {
        await updatePipelineRun(env.DB, pipelineId, {
          stage: 'failed',
          errorMessage: failure.message,
        });
      }
    }

    logger.error('Task execution failed', {
      taskId: claimed.id,
      type: claimed.type,
      attempts: claimed.attempts,
      nextStatus: failure.status,
      error: failure.message,
    });

    await logSystemEvent(env.DB, 'error', 'task_worker', `Task ${claimed.id} (${claimed.type}) failed`, {
      attempts: claimed.attempts,
      nextStatus: failure.status,
      error: failure.message,
    });

    if (failure.status === 'dead_letter') {
      try {
        await sendNotification(env, {
          title: 'AUTOBLOGGER Task Dead-Letter Alert',
          body: `Task ${claimed.type} failed permanently after ${claimed.attempts} attempts.`,
          data: { event: 'task_dead_letter', taskId: claimed.id },
        });
      } catch {
        // Non-fatal
      }
    }

    return {
      taskId: claimed.id,
      status: failure.status,
      shouldRetryMessage: failure.status === 'retrying',
      delaySeconds: failure.delaySeconds,
      error: failure.message,
    };
  }
}

export async function processDueRetryQueue(
  env: WorkerEnv,
  limit = 10
): Promise<{
  processed: number;
  outcomes: Array<{ taskId: string; status: string; error?: string }>;
}> {
  const dueTasks = await listDueRetryTasks(env, limit);
  const outcomes: Array<{ taskId: string; status: string; error?: string }> = [];

  for (const task of dueTasks) {
    const outcome = await executeTaskById(env, task.id);
    outcomes.push({ taskId: outcome.taskId, status: outcome.status, error: outcome.error });
  }

  return {
    processed: outcomes.length,
    outcomes,
  };
}

/**
 * Cloudflare Queues Consumer Handler
 */
export async function handleQueueBatch(
  batch: MessageBatch<QueueTaskMessage>,
  env: WorkerEnv
): Promise<void> {
  for (const message of batch.messages) {
    const { taskId } = message.body;
    const outcome = await executeTaskById(env, taskId);

    if (outcome.shouldRetryMessage) {
      message.retry({ delaySeconds: Math.max(10, outcome.delaySeconds || 30) });
    } else {
      message.ack();
    }
  }
}

/**
 * Cloudflare Cron Triggers Scheduled Handler
 */
export async function handleScheduledCron(
  controller: ScheduledController,
  env: WorkerEnv
): Promise<void> {
  const cron = controller.cron;
  const dateKey = new Date(controller.scheduledTime || Date.now()).toISOString().slice(0, 13);

  logger.info('Cloudflare Cron Trigger fired', { cron });

  // 1. Daily Analytics Sync (50 23 * * *)
  if (cron === '50 23 * * *') {
    await enqueueTask(env, {
      type: 'SYNC_ANALYTICS_DAILY',
      createdBy: 'cron:daily',
      idempotencyKey: `cron:analytics:daily:${dateKey.slice(0, 10)}`,
      payload: { cron },
    });
    return;
  }

  // 2. Weekly Analytics Sync (55 23 * * 0)
  if (cron === '55 23 * * 0') {
    await enqueueTask(env, {
      type: 'SYNC_ANALYTICS_WEEKLY',
      createdBy: 'cron:weekly',
      idempotencyKey: `cron:analytics:weekly:${dateKey.slice(0, 10)}`,
      payload: { cron },
    });
    return;
  }

  // 3. Default periodic tick (*/15 * * * *): run autonomous scheduler & process due retries
  const state = await getAgentState(env);
  if (!state.emergencyStop && state.status === 'running') {
    await runSchedulerTick(env, 'cron:scheduler');
  } else {
    logger.info('Skipping scheduler tick because agent is paused or stopped', {
      status: state.status,
      emergencyStop: state.emergencyStop,
    });
  }

  await processDueRetryQueue(env, 5);
}
