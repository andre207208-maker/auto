import { logSystemEvent } from '../db/repositories.js';
import { getAdsterraStats } from '../services/adsterraService.js';
import { sendNotification } from '../services/fcmService.js';
import { runGA4Report } from '../services/ga4Service.js';
import { querySearchAnalytics } from '../services/searchConsoleService.js';
import { WorkerEnv } from '../types/index.js';
import { logger } from '../utils/logger.js';

function formatDateDaysAgo(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export async function runAnalyticsSyncJob(
  env: WorkerEnv,
  period: 'daily' | 'weekly'
): Promise<Record<string, unknown>> {
  const days = period === 'daily' ? 1 : 7;
  const startDate = formatDateDaysAgo(days);
  const endDate = formatDateDaysAgo(0);
  const generatedAt = new Date().toISOString();

  const sources: Record<string, unknown> = {};
  const errors: Array<{ source: string; message: string }> = [];

  // 1. D1 posts count in period
  let publishedPostsCount = 0;
  try {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM posts WHERE published_at >= ?`
    )
      .bind(`${startDate}T00:00:00.000Z`)
      .first<{ cnt: number }>();
    publishedPostsCount = countRow?.cnt ?? 0;
    sources.publishedPostsCount = publishedPostsCount;
  } catch (err) {
    errors.push({ source: 'd1_posts', message: err instanceof Error ? err.message : String(err) });
  }

  // 2. GA4 traffic metrics
  try {
    sources.ga4 = await runGA4Report(env, { startDate, endDate });
  } catch (err) {
    errors.push({ source: 'ga4', message: err instanceof Error ? err.message : String(err) });
  }

  // 3. Google Search Console metrics
  try {
    sources.searchConsole = await querySearchAnalytics(env, { startDate, endDate, rowLimit: 25 });
  } catch (err) {
    errors.push({
      source: 'search_console',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Adsterra revenue & impressions
  try {
    sources.adsterra = await getAdsterraStats(env, {
      startDate,
      finishDate: endDate,
      groupBy: 'date',
    });
  } catch (err) {
    errors.push({ source: 'adsterra', message: err instanceof Error ? err.message : String(err) });
  }

  const snapshotId = `${period}_${endDate}`;

  await env.DB.prepare(
    `INSERT INTO analytics_snapshots (
       id, period, start_date, end_date, published_posts_count, sources_json, errors_json, generated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       published_posts_count = excluded.published_posts_count,
       sources_json = excluded.sources_json,
       errors_json = excluded.errors_json,
       generated_at = excluded.generated_at`
  )
    .bind(
      snapshotId,
      period,
      startDate,
      endDate,
      publishedPostsCount,
      JSON.stringify(sources),
      JSON.stringify(errors),
      generatedAt
    )
    .run();

  await logSystemEvent(env.DB, 'info', 'analytics_job', `Completed ${period} analytics aggregation`, {
    snapshotId,
    errorCount: errors.length,
  });

  try {
    await sendNotification(env, {
      title: `AUTOBLOGGER ${period === 'daily' ? 'Daily' : 'Weekly'} Report Ready`,
      body: `Analytics snapshot (${startDate} to ${endDate}) synced. Posts published: ${publishedPostsCount}.`,
      data: {
        event: 'analytics_synced',
        period,
        snapshotId,
      },
    });
  } catch (err) {
    logger.warn('Failed to send analytics notification', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    id: snapshotId,
    period,
    startDate,
    endDate,
    publishedPostsCount,
    sources,
    errors,
    generatedAt,
  };
}
