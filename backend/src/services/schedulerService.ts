import {
  deleteCampaignRow,
  listCampaignRows,
  updateCampaignQuotaRow,
  upsertCampaignRow,
} from '../db/repositories.js';
import { CampaignSchedule, WorkerEnv } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { startAutonomousPipeline } from '../workers/publishWorker.js';
import { assertAgentOperational } from './agentControlService.js';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function listCampaigns(env: WorkerEnv): Promise<CampaignSchedule[]> {
  return listCampaignRows(env.DB, false);
}

export async function createOrUpdateCampaign(
  env: WorkerEnv,
  input: Omit<CampaignSchedule, 'id' | 'postsPublishedToday' | 'createdAt' | 'updatedAt'> & {
    id?: string;
  }
): Promise<CampaignSchedule> {
  const existingAll = await listCampaignRows(env.DB, false);
  const existing = input.id ? existingAll.find((c) => c.id === input.id) : undefined;
  const id = input.id || crypto.randomUUID();
  const now = new Date().toISOString();

  const payload: CampaignSchedule = {
    id,
    name: input.name,
    niche: input.niche,
    blogId: input.blogId,
    enabled: input.enabled,
    cronExpression: input.cronExpression,
    postsPerDay: input.postsPerDay,
    publishAsDraft: input.publishAsDraft,
    injectAds: input.injectAds,
    preferredProvider: input.preferredProvider,
    language: input.language || 'English',
    targetKeywords: input.targetKeywords || [],
    lastRunAt: existing?.lastRunAt ?? null,
    postsPublishedToday: existing?.postsPublishedToday ?? 0,
    lastResetDate: existing?.lastResetDate ?? todayIsoDate(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await upsertCampaignRow(env.DB, payload);
  return payload;
}

export async function deleteCampaign(env: WorkerEnv, id: string): Promise<void> {
  await deleteCampaignRow(env.DB, id);
}

export async function runSchedulerTick(
  env: WorkerEnv,
  triggeredBy: string
): Promise<{
  evaluatedCampaigns: number;
  enqueuedPipelines: number;
  pipelineIds: string[];
  taskIds: string[];
}> {
  await assertAgentOperational(env);

  const today = todayIsoDate();
  const enabledCampaigns = await listCampaignRows(env.DB, true);

  let evaluatedCampaigns = 0;
  const pipelineIds: string[] = [];
  const taskIds: string[] = [];

  for (const campaign of enabledCampaigns) {
    evaluatedCampaigns += 1;

    const countToday = campaign.lastResetDate === today ? campaign.postsPublishedToday || 0 : 0;
    if (countToday >= campaign.postsPerDay) {
      continue;
    }

    const seedKeyword =
      campaign.targetKeywords.length > 0
        ? campaign.targetKeywords[countToday % campaign.targetKeywords.length]
        : undefined;

    const { pipeline, initialTaskId } = await startAutonomousPipeline(env, {
      campaignId: campaign.id,
      niche: campaign.niche,
      seedKeyword,
      blogId: campaign.blogId,
      language: campaign.language,
      publishAsDraft: campaign.publishAsDraft,
      injectAds: campaign.injectAds,
      preferredProvider: campaign.preferredProvider,
      triggeredBy,
      idempotencyKey: `campaign:${campaign.id}:${today}:slot:${countToday}`,
    });

    pipelineIds.push(pipeline.id);
    taskIds.push(initialTaskId);

    await updateCampaignQuotaRow(env.DB, campaign.id, countToday + 1, today);
  }

  logger.info('Autonomous scheduler tick completed', {
    evaluatedCampaigns,
    enqueuedPipelines: pipelineIds.length,
    triggeredBy,
  });

  return {
    evaluatedCampaigns,
    enqueuedPipelines: pipelineIds.length,
    pipelineIds,
    taskIds,
  };
}
