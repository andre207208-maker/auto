import { getDb } from '../config/firebase.js';
import { AIProviderName } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { injectAdsIntoPostHtml } from '../services/adsterraService.js';
import { assertAgentOperational } from '../services/agentControlService.js';
import { publishBloggerPost } from '../services/bloggerService.js';
import { generateArticle } from '../services/contentGeneratorService.js';
import { sendNotification } from '../services/fcmService.js';
import { COLLECTIONS, logSystemEvent } from '../services/firestoreService.js';
import { researchTopic } from '../services/researchService.js';
import { appendJsonLdToHtml, auditSeo } from '../services/seoService.js';

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
}

export interface PublishPipelineOutput {
  postRecordId: string;
  bloggerPostId: string;
  bloggerUrl: string;
  title: string;
  primaryKeyword: string;
  seoScore: number;
  wordCount: number;
  providerUsed: AIProviderName;
  modelUsed: string;
  publishedAt: string;
}

export async function runAutonomousPublishPipeline(
  input: PublishPipelineInput
): Promise<PublishPipelineOutput> {
  // Block execution immediately if paused or emergency-stopped
  await assertAgentOperational();

  logger.info('Starting autonomous publish pipeline', {
    niche: input.niche,
    campaignId: input.campaignId,
  });

  // 1. Research topic & keywords
  const research = await researchTopic({
    niche: input.niche,
    seedKeyword: input.seedKeyword,
    language: input.language,
    preferredProvider: input.preferredProvider,
  });

  // Re-check agent state between long AI steps
  await assertAgentOperational();

  // 2. Generate long-form article
  const selectedTitle = research.suggestedTitles?.[0] || `${research.primaryKeyword} Complete Guide`;
  const article = await generateArticle({
    topic: selectedTitle,
    primaryKeyword: research.primaryKeyword,
    secondaryKeywords: research.secondaryKeywords,
    outline: research.outline,
    language: input.language,
    tone: input.tone,
    preferredProvider: input.preferredProvider,
  });

  // 3. Audit SEO and build JSON-LD structured data
  const seoAudit = auditSeo({
    title: article.title,
    metaDescription: article.metaDescription,
    htmlContent: article.htmlContent,
    primaryKeyword: research.primaryKeyword,
    slug: article.slug,
    faqItems: article.faqItems,
  });

  let finalHtml = appendJsonLdToHtml(article.htmlContent, seoAudit.jsonLdSchema);

  // 4. Inject Adsterra ad units if enabled
  if (input.injectAds !== false) {
    finalHtml = await injectAdsIntoPostHtml(finalHtml);
  }

  await assertAgentOperational();

  // 5. Publish to Blogger
  const bloggerPost = await publishBloggerPost({
    blogId: input.blogId,
    title: article.title,
    content: finalHtml,
    labels: article.labels,
    isDraft: input.publishAsDraft ?? false,
  });

  const publishedAt = new Date().toISOString();

  // 6. Store post record in Firestore
  const db = getDb();
  const postDoc = await db.collection(COLLECTIONS.POSTS).add({
    campaignId: input.campaignId || null,
    blogId: input.blogId || null,
    bloggerPostId: bloggerPost.id,
    bloggerUrl: bloggerPost.url,
    title: article.title,
    slug: seoAudit.optimizedSlug,
    metaDescription: article.metaDescription,
    primaryKeyword: research.primaryKeyword,
    secondaryKeywords: research.secondaryKeywords,
    labels: article.labels,
    wordCount: article.wordCount,
    seoScore: seoAudit.score,
    providerUsed: article.providerUsed,
    modelUsed: article.modelUsed,
    isDraft: Boolean(input.publishAsDraft),
    triggeredBy: input.triggeredBy || 'autonomous_scheduler',
    publishedAt,
  });

  await logSystemEvent('info', 'publish_pipeline', `Published post: ${article.title}`, {
    postRecordId: postDoc.id,
    bloggerPostId: bloggerPost.id,
    bloggerUrl: bloggerPost.url,
    seoScore: seoAudit.score,
    providerUsed: article.providerUsed,
  });

  // 7. Send FCM push notification
  try {
    await sendNotification({
      title: input.publishAsDraft ? 'Draft Created by AUTOBLOGGER' : 'New Post Published',
      body: `${article.title} (SEO Score: ${seoAudit.score}/100)`,
      data: {
        event: 'post_published',
        postRecordId: postDoc.id,
        bloggerUrl: bloggerPost.url || '',
      },
    });
  } catch (err) {
    logger.warn('FCM notification failed after publishing post', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    postRecordId: postDoc.id,
    bloggerPostId: bloggerPost.id,
    bloggerUrl: bloggerPost.url,
    title: article.title,
    primaryKeyword: research.primaryKeyword,
    seoScore: seoAudit.score,
    wordCount: article.wordCount,
    providerUsed: article.providerUsed,
    modelUsed: article.modelUsed,
    publishedAt,
  };
}
