import crypto from 'crypto';
import { getDb } from '../config/firebase.js';
import { CampaignSchedule } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { assertAgentOperational } from './agentControlService.js';
import { COLLECTIONS } from './firestoreService.js';
import { enqueueTask } from './taskQueueService.js';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function listCampaigns(): Promise<CampaignSchedule[]> {
  const snap = await getDb().collection(COLLECTIONS.CAMPAIGNS).orderBy('createdAt', 'desc').get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CampaignSchedule, 'id'>) }));
}

export async function createOrUpdateCampaign(
  input: Omit<CampaignSchedule, 'id' | 'postsPublishedToday' | 'createdAt' | 'updatedAt'> & {
    id?: string;
  }
): Promise<CampaignSchedule> {
  const db = getDb();
  const id = input.id || crypto.randomUUID();
  const now = new Date().toISOString();
  const docRef = db.collection(COLLECTIONS.CAMPAIGNS).doc(id);
  const existing = await docRef.get();

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
    lastRunAt: existing.exists ? (existing.data() as CampaignSchedule).lastRunAt || null : null,
    postsPublishedToday: existing.exists
      ? (existing.data() as CampaignSchedule).postsPublishedToday || 0
      : 0,
    lastResetDate: existing.exists
      ? (existing.data() as CampaignSchedule).lastResetDate || todayIsoDate()
      : todayIsoDate(),
    createdAt: existing.exists ? (existing.data() as CampaignSchedule).createdAt : now,
    updatedAt: now,
  };

  await docRef.set(payload, { merge: true });
  return payload;
}

export async function deleteCampaign(id: string): Promise<void> {
  await getDb().collection(COLLECTIONS.CAMPAIGNS).doc(id).delete();
}

export async function runSchedulerTick(triggeredBy: string): Promise<{
  evaluatedCampaigns: number;
  enqueuedJobs: number;
  taskIds: string[];
}> {
  await assertAgentOperational();

  const db = getDb();
  const today = todayIsoDate();
  const snap = await db.collection(COLLECTIONS.CAMPAIGNS).where('enabled', '==', true).get();

  let evaluatedCampaigns = 0;
  const taskIds: string[] = [];

  for (const doc of snap.docs) {
    evaluatedCampaigns += 1;
    const campaign = { id: doc.id, ...(doc.data() as Omit<CampaignSchedule, 'id'>) };

    const countToday = campaign.lastResetDate === today ? campaign.postsPublishedToday || 0 : 0;
    if (countToday >= campaign.postsPerDay) {
      continue;
    }

    const seedKeyword =
      campaign.targetKeywords.length > 0
        ? campaign.targetKeywords[countToday % campaign.targetKeywords.length]
        : undefined;

    const task = await enqueueTask({
      type: 'GENERATE_AND_PUBLISH',
      createdBy: triggeredBy,
      payload: {
        campaignId: campaign.id,
        niche: campaign.niche,
        seedKeyword,
        blogId: campaign.blogId,
        language: campaign.language,
        publishAsDraft: campaign.publishAsDraft,
        injectAds: campaign.injectAds,
        preferredProvider: campaign.preferredProvider,
        triggeredBy,
      },
    });

    taskIds.push(task.id);

    await doc.ref.update({
      postsPublishedToday: countToday + 1,
      lastResetDate: today,
      lastRunAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  logger.info('Autonomous scheduler tick completed', {
    evaluatedCampaigns,
    enqueuedJobs: taskIds.length,
    triggeredBy,
  });

  return {
    evaluatedCampaigns,
    enqueuedJobs: taskIds.length,
    taskIds,
  };
}
