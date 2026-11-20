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
  releaseExpiredLocks,
} from '../services/taskQueueService.js';
import { TaskType, WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  runAnalyticsSyncJob,
  runContentUpdateCheckJob,
  runSeoAuditBatchJob,
} from './analyticsWorker.js';
import {
  executePipelineGenerateStage,
  executePipelinePublishStage,
  executePipelineResearchStage,
  PublishPipelineInput,
  startAutonomousPipeline,
} from './publishWorker.js';

const DEFAULT_CRON_JOB_BATCH_SIZE = 3;
const DEFAULT_MAX_WALL_MS = 20_000;

const AGENT_GATED_TASK_TYPES = new Set<TaskType>([
  'PIPELINE_RESEARCH',
  'PIPELINE_GENERATE',
  'PIPELINE_OPTIMIZE_AND_PUBLISH',
  'GENERATE_AND_PUBLISH',
  'RESEARCH_TOPIC',
  'GENERATE_ARTICLE',
]);

export async function executeTaskById(
  env: WorkerEnv,
  taskId: string,
  workerId = `worker-${crypto.randomUUID().slice(0, 8)}`
): Promise<{
  taskId: string;
  status: string;
  result?: Record<string, unknown>;
  error?: string;
}> {
  const preState = await getAgentState(env);
  if (preState.emergencyStop || preState.status === 'stopped') {
    return {
      taskId,
      status: 'skipped_emergency_stop',
      error: preState.reason || 'Agent stopped by emergency stop',
    };
  }
  if (preState.status === 'paused') {
    return {
      taskId,
      status: 'skipped_paused',
      error: preState.reason || 'Agent is paused',
    };
  }

  const claimed = await claimTask(env, taskId, workerId, 120);
  if (!claimed) {
    return { taskId, status: 'skipped_or_already_claimed' };
  }

  try {
    if (AGENT_GATED_TASK_TYPES.has(claimed.type)) {
      const state = await getAgentState(env);
      if (state.emergencyStop || state.status === 'stopped') {
        throw new AppError(
          `Autonomous agent is halted by emergency stop${state.reason ? `: ${state.reason}` : ''}`,
          423,
          'AGENT_EMERGENCY_STOPPED'
        );
      }
      if (state.status === 'paused') {
        throw new AppError(
          `Autonomous agent is paused${state.reason ? `: ${state.reason}` : ''}`,
          423,
          'AGENT_PAUSED'
        );
      }
    }

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
      case 'SEO_AUDIT_BATCH': {
        result = await runSeoAuditBatchJob(env);
        break;
      }
      case 'CONTENT_UPDATE_CHECK': {
        result = await runContentUpdateCheckJob(env);
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
    return { taskId: claimed.id, status: 'completed', result };
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

    logger.error('D1 job execution failed', {
      taskId: claimed.id,
      type: claimed.type,
      attempts: claimed.attempts,
      nextStatus: failure.status,
      error: failure.message,
    });

    await logSystemEvent(
      env.DB,
      'error',
      'd1_job_worker',
      `Job ${claimed.id} (${claimed.type}) failed`,
      {
        attempts: claimed.attempts,
        nextStatus: failure.status,
        error: failure.message,
      }
    );

    if (failure.status === 'dead_letter') {
      try {
        await sendNotification(env, {
          title: 'AUTOBLOGGER Job Failed Permanently',
          body: `Job ${claimed.type} moved to dead_letter after ${claimed.attempts} attempts.`,
          data: { event: 'task_dead_letter', taskId: claimed.id },
        });
      } catch {
        // Non-fatal
      }
    }

    return {
      taskId: claimed.id,
      status: failure.status,
      error: failure.message,
    };
  }
}

export async function processD1JobBatch(
  env: WorkerEnv,
  options?: { limit?: number; workerId?: string; maxWallMs?: number }
): Promise<{
  processed: number;
  recoveredLocks: number;
  skippedReason?: 'paused' | 'emergency_stop';
  outcomes: Array<{ taskId: string; status: string; error?: string }>;
}> {
  const state = await getAgentState(env);
  if (state.emergencyStop || state.status === 'stopped') {
    logger.info('Skipping D1 job batch because agent is stopped', {
      status: state.status,
      emergencyStop: state.emergencyStop,
    });
    return {
      processed: 0,
      recoveredLocks: 0,
      skippedReason: 'emergency_stop',
      outcomes: [],
    };
  }
  if (state.status === 'paused') {
    logger.info('Skipping D1 job batch because agent is paused', { status: state.status });
    return {
      processed: 0,
      recoveredLocks: 0,
      skippedReason: 'paused',
      outcomes: [],
    };
  }

  const recoveredLocks = await releaseExpiredLocks(env);
  const safeLimit = Math.min(Math.max(1, options?.limit ?? DEFAULT_CRON_JOB_BATCH_SIZE), 5);
  const workerId = options?.workerId || `cron-${crypto.randomUUID().slice(0, 8)}`;
  const maxWallMs = options?.maxWallMs ?? DEFAULT_MAX_WALL_MS;
  const startedAt = Date.now();

  const dueTasks = await listDueRetryTasks(env, safeLimit);
  const outcomes: Array<{ taskId: string; status: string; error?: string }> = [];

  for (const task of dueTasks) {
    if (outcomes.length > 0 && Date.now() - startedAt >= maxWallMs) {
      logger.info('Stopping D1 job batch early to stay within Free Worker execution budget', {
        processed: outcomes.length,
        elapsedMs: Date.now() - startedAt,
      });
      break;
    }

    const outcome = await executeTaskById(env, task.id, workerId);
    outcomes.push({ taskId: outcome.taskId, status: outcome.status, error: outcome.error });
  }

  return {
    processed: outcomes.length,
    recoveredLocks,
    outcomes,
  };
}

export async function processDueRetryQueue(
  env: WorkerEnv,
  limit = DEFAULT_CRON_JOB_BATCH_SIZE
): Promise<{
  processed: number;
  recoveredLocks: number;
  skippedReason?: 'paused' | 'emergency_stop';
  outcomes: Array<{ taskId: string; status: string; error?: string }>;
}> {
  return processD1JobBatch(env, { limit, workerId: 'manual-retry-sweep' });
}

/**
 * Cloudflare Free-Plan Cron Triggers Handler (replaces paid Cloudflare Queues)
 */
export async function handleScheduledCron(
  controller: ScheduledController,
  env: WorkerEnv
): Promise<void> {
  const cron = controller.cron;
  const dateKey = new Date(controller.scheduledTime || Date.now()).toISOString().slice(0, 13);

  logger.info('Cloudflare Cron Trigger fired', { cron });

  const state = await getAgentState(env);

  // 1. Daily Analytics Sync & Traffic Drop Insights (50 23 * * *)
  if (cron === '50 23 * * *') {
    if (!state.emergencyStop && state.status !== 'stopped') {
      await enqueueTask(env, {
        type: 'SYNC_ANALYTICS_DAILY',
        createdBy: 'cron:daily',
        priority: 3,
        idempotencyKey: `cron:analytics:daily:${dateKey.slice(0, 10)}`,
        payload: { cron },
      });
      await processD1JobBatch(env, { limit: 2, workerId: 'cron:daily' });
    }
    return;
  }

  // 2. Weekly Analytics, SEO Batch Audit & Content Freshness Check (55 23 * * SUN)
  if (cron === '55 23 * * SUN' || cron === '55 23 * * 1') {
    if (!state.emergencyStop && state.status !== 'stopped') {
      await enqueueTask(env, {
        type: 'SYNC_ANALYTICS_WEEKLY',
        createdBy: 'cron:weekly',
        priority: 3,
        idempotencyKey: `cron:analytics:weekly:${dateKey.slice(0, 10)}`,
        payload: { cron },
      });
      await enqueueTask(env, {
        type: 'SEO_AUDIT_BATCH',
        createdBy: 'cron:weekly',
        priority: 4,
        idempotencyKey: `cron:seo-audit:${dateKey.slice(0, 10)}`,
        payload: { cron },
      });
      await enqueueTask(env, {
        type: 'CONTENT_UPDATE_CHECK',
        createdBy: 'cron:weekly',
        priority: 4,
        idempotencyKey: `cron:content-update:${dateKey.slice(0, 10)}`,
        payload: { cron },
      });
      await processD1JobBatch(env, { limit: 3, workerId: 'cron:weekly' });
    }
    return;
  }

  // 3. Periodic tick (*/15 * * * *): schedule due campaigns & process bounded batch of D1 jobs
  if (!state.emergencyStop && state.status === 'running') {
    await runSchedulerTick(env, 'cron:scheduler');
  } else {
    logger.info('Skipping scheduler tick because agent is paused or stopped', {
      status: state.status,
      emergencyStop: state.emergencyStop,
    });
  }

  await processD1JobBatch(env, { limit: DEFAULT_CRON_JOB_BATCH_SIZE, workerId: 'cron:15m' });
}
