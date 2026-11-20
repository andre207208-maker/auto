import {
  createPipelineRun,
  getPipelineRunById,
  insertPostRecord,
  logSystemEvent,
  updatePipelineRun,
} from '../db/repositories.js';
import { injectAdsIntoPostHtml } from '../services/adsterraService.js';
import { assertAgentOperational } from '../services/agentControlService.js';
import { publishBloggerPost } from '../services/bloggerService.js';
import { generateArticle } from '../services/contentGeneratorService.js';
import { sendNotification } from '../services/fcmService.js';
import { uploadMediaToR2 } from '../services/r2MediaService.js';
import { researchTopic } from '../services/researchService.js';
import { appendJsonLdToHtml, auditSeo } from '../services/seoService.js';
import { enqueueTask } from '../services/taskQueueService.js';
import { AIProviderName, PipelineRun, WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface PublishPipelineInput {
  niche: string;
  seedKeyword?: string;
  blogId?: string;
  language?: string;
  tone?: string;
  publishAsDraft?: boolean;
  injectAds?: boolean;
  preferredProvider?: AIProviderName;
  campaignId?: string;
  triggeredBy?: string;
  idempotencyKey?: string;
}

/**
 * Starts the 3-stage asynchronous pipeline on Cloudflare Queues so no single
 * Worker invocation runs multiple long AI calls synchronously.
 */
export async function startAutonomousPipeline(
  env: WorkerEnv,
  input: PublishPipelineInput
): Promise<{ pipeline: PipelineRun; initialTaskId: string }> {
  await assertAgentOperational(env);

  const pipelineId = crypto.randomUUID();
  const pipeline = await createPipelineRun(env.DB, {
    id: pipelineId,
    campaignId: input.campaignId ?? null,
    stage: 'research_queued',
    niche: input.niche,
    seedKeyword: input.seedKeyword ?? null,
    blogId: input.blogId ?? null,
    language: input.language || 'English',
    tone: input.tone ?? null,
    publishAsDraft: Boolean(input.publishAsDraft),
    injectAds: input.injectAds !== false,
    preferredProvider: input.preferredProvider ?? null,
    triggeredBy: input.triggeredBy || 'api',
  });

  const { task } = await enqueueTask(env, {
    type: 'PIPELINE_RESEARCH',
    createdBy: input.triggeredBy || 'api',
    idempotencyKey: input.idempotencyKey
      ? `${input.idempotencyKey}:research`
      : `pipeline:${pipelineId}:research`,
    payload: { pipelineId },
  });

  return { pipeline, initialTaskId: task.id };
}

/**
 * Stage 1: Tavily + AI Topic & Keyword Research -> enqueues Stage 2 (Article Generation)
 */
export async function executePipelineResearchStage(
  env: WorkerEnv,
  pipelineId: string
): Promise<Record<string, unknown>> {
  await assertAgentOperational(env);

  const run = await getPipelineRunById(env.DB, pipelineId);
  if (!run) {
    throw new AppError(`Pipeline run ${pipelineId} not found`, 404, 'PIPELINE_NOT_FOUND');
  }
  if (run.stage === 'cancelled' || run.stage === 'completed') {
    return { skipped: true, stage: run.stage };
  }

  const research = await researchTopic(env, {
    niche: run.niche,
    seedKeyword: run.seedKeyword ?? undefined,
    language: run.language,
    preferredProvider: run.preferredProvider ?? undefined,
  });

  await updatePipelineRun(env.DB, pipelineId, {
    stage: 'generate_queued',
    research,
  });

  const { task } = await enqueueTask(env, {
    type: 'PIPELINE_GENERATE',
    createdBy: run.triggeredBy,
    idempotencyKey: `pipeline:${pipelineId}:generate`,
    payload: { pipelineId },
  });

  return {
    pipelineId,
    stage: 'generate_queued',
    primaryKeyword: research.primaryKeyword,
    nextTaskId: task.id,
  };
}

/**
 * Stage 2: Long-form Article Generation -> enqueues Stage 3 (SEO, Ads, R2, Blogger)
 */
export async function executePipelineGenerateStage(
  env: WorkerEnv,
  pipelineId: string
): Promise<Record<string, unknown>> {
  await assertAgentOperational(env);

  const run = await getPipelineRunById(env.DB, pipelineId);
  if (!run || !run.research) {
    throw new AppError(
      `Pipeline run ${pipelineId} missing research output`,
      409,
      'PIPELINE_INVALID_STATE'
    );
  }
  if (run.stage === 'cancelled' || run.stage === 'completed') {
    return { skipped: true, stage: run.stage };
  }

  const selectedTitle =
    run.research.suggestedTitles?.[0] || `${run.research.primaryKeyword} Complete Guide`;

  const article = await generateArticle(env, {
    topic: selectedTitle,
    primaryKeyword: run.research.primaryKeyword,
    secondaryKeywords: run.research.secondaryKeywords,
    outline: run.research.outline,
    language: run.language,
    tone: run.tone ?? undefined,
    preferredProvider: run.preferredProvider ?? undefined,
  });

  await updatePipelineRun(env.DB, pipelineId, {
    stage: 'publish_queued',
    article,
  });

  const { task } = await enqueueTask(env, {
    type: 'PIPELINE_OPTIMIZE_AND_PUBLISH',
    createdBy: run.triggeredBy,
    idempotencyKey: `pipeline:${pipelineId}:publish`,
    payload: { pipelineId },
  });

  return {
    pipelineId,
    stage: 'publish_queued',
    title: article.title,
    wordCount: article.wordCount,
    nextTaskId: task.id,
  };
}

/**
 * Stage 3: SEO Audit, JSON-LD, Adsterra Injection, optional R2 Backup, Blogger Publish, D1 & FCM
 */
export async function executePipelinePublishStage(
  env: WorkerEnv,
  pipelineId: string
): Promise<Record<string, unknown>> {
  await assertAgentOperational(env);

  const run = await getPipelineRunById(env.DB, pipelineId);
  if (!run || !run.research || !run.article) {
    throw new AppError(
      `Pipeline run ${pipelineId} missing article output`,
      409,
      'PIPELINE_INVALID_STATE'
    );
  }
  if (run.stage === 'cancelled') {
    return { skipped: true, stage: run.stage };
  }
  if (run.stage === 'completed' && run.result) {
    return run.result;
  }

  const seoAudit = auditSeo({
    title: run.article.title,
    metaDescription: run.article.metaDescription,
    htmlContent: run.article.htmlContent,
    primaryKeyword: run.research.primaryKeyword,
    slug: run.article.slug,
    faqItems: run.article.faqItems,
  });

  let finalHtml = appendJsonLdToHtml(run.article.htmlContent, seoAudit.jsonLdSchema);

  if (run.injectAds) {
    finalHtml = await injectAdsIntoPostHtml(env, finalHtml);
  }

  // Optional R2 archive backup of generated HTML
  let r2AssetKey: string | null = null;
  if (env.MEDIA_BUCKET) {
    try {
      const key = `posts/${new Date().toISOString().slice(0, 10)}/${pipelineId}.html`;
      await uploadMediaToR2(env, {
        key,
        body: finalHtml,
        contentType: 'text/html; charset=utf-8',
        metadata: { pipelineId, title: run.article.title },
      });
      r2AssetKey = key;
    } catch (err) {
      logger.warn('Optional R2 article backup failed; continuing publish', {
        pipelineId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const bloggerPost = await publishBloggerPost(env, {
    blogId: run.blogId ?? undefined,
    title: run.article.title,
    content: finalHtml,
    labels: run.article.labels,
    isDraft: run.publishAsDraft,
  });

  const publishedAt = new Date().toISOString();
  const postRecordId = crypto.randomUUID();

  await insertPostRecord(env.DB, {
    id: postRecordId,
    pipelineId,
    campaignId: run.campaignId ?? null,
    blogId: run.blogId || env.DEFAULT_BLOGGER_BLOG_ID || '',
    bloggerPostId: bloggerPost.id,
    bloggerUrl: bloggerPost.url,
    title: run.article.title,
    slug: seoAudit.optimizedSlug,
    metaDescription: run.article.metaDescription,
    primaryKeyword: run.research.primaryKeyword,
    secondaryKeywords: run.research.secondaryKeywords,
    labels: run.article.labels,
    wordCount: run.article.wordCount,
    seoScore: seoAudit.score,
    providerUsed: run.article.providerUsed,
    modelUsed: run.article.modelUsed,
    isDraft: run.publishAsDraft,
    r2AssetKey,
    triggeredBy: run.triggeredBy,
    publishedAt,
  });

  const result = {
    postRecordId,
    pipelineId,
    bloggerPostId: bloggerPost.id,
    bloggerUrl: bloggerPost.url,
    title: run.article.title,
    primaryKeyword: run.research.primaryKeyword,
    seoScore: seoAudit.score,
    wordCount: run.article.wordCount,
    providerUsed: run.article.providerUsed,
    modelUsed: run.article.modelUsed,
    r2AssetKey,
    publishedAt,
  };

  await updatePipelineRun(env.DB, pipelineId, {
    stage: 'completed',
    seo: seoAudit,
    result,
    completedAt: publishedAt,
  });

  await logSystemEvent(env.DB, 'info', 'publish_pipeline', `Published post: ${run.article.title}`, {
    postRecordId,
    bloggerPostId: bloggerPost.id,
    seoScore: seoAudit.score,
  });

  await sendNotification(env, {
    title: run.publishAsDraft ? 'Draft Created by AUTOBLOGGER' : 'New Post Published',
    body: `${run.article.title} (SEO Score: ${seoAudit.score}/100)`,
    data: {
      event: 'post_published',
      postRecordId,
      bloggerUrl: bloggerPost.url || '',
    },
  });

  return result;
}
