import { getDb } from '../config/firebase.js';
import { getAdsterraStats } from '../services/adsterraService.js';
import { sendNotification } from '../services/fcmService.js';
import { COLLECTIONS, logSystemEvent } from '../services/firestoreService.js';
import { runGA4Report } from '../services/ga4Service.js';
import { querySearchAnalytics } from '../services/searchConsoleService.js';
import { logger } from '../utils/logger.js';

function formatDateDaysAgo(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export async function runAnalyticsSyncJob(period: 'daily' | 'weekly'): Promise<Record<string, unknown>> {
  const days = period === 'daily' ? 1 : 7;
  const startDate = formatDateDaysAgo(days);
  const endDate = formatDateDaysAgo(0);

  const summary: Record<string, unknown> = {
    period,
    startDate,
    endDate,
    generatedAt: new Date().toISOString(),
    sources: {},
    errors: [],
  };

  const sources: Record<string, unknown> = {};
  const errors: Array<{ source: string; message: string }> = [];

  // 1. Firestore posts count in period
  try {
    const db = getDb();
    const postsSnap = await db
      .collection(COLLECTIONS.POSTS)
      .where('publishedAt', '>=', `${startDate}T00:00:00.000Z`)
      .get();
    sources.publishedPostsCount = postsSnap.size;
  } catch (err) {
    errors.push({ source: 'firestore_posts', message: err instanceof Error ? err.message : String(err) });
  }

  // 2. GA4 traffic metrics
  try {
    sources.ga4 = await runGA4Report({ startDate, endDate });
  } catch (err) {
    errors.push({ source: 'ga4', message: err instanceof Error ? err.message : String(err) });
  }

  // 3. Google Search Console metrics
  try {
    sources.searchConsole = await querySearchAnalytics({ startDate, endDate, rowLimit: 25 });
  } catch (err) {
    errors.push({ source: 'search_console', message: err instanceof Error ? err.message : String(err) });
  }

  // 4. Adsterra revenue & impressions
  try {
    sources.adsterra = await getAdsterraStats({ startDate, finishDate: endDate, groupBy: 'date' });
  } catch (err) {
    errors.push({ source: 'adsterra', message: err instanceof Error ? err.message : String(err) });
  }

  summary.sources = sources;
  summary.errors = errors;

  // Store snapshot in Firestore
  const db = getDb();
  const docId = `${period}_${endDate}`;
  await db.collection(COLLECTIONS.ANALYTICS_SNAPSHOTS).doc(docId).set(summary, { merge: true });

  await logSystemEvent('info', 'analytics_job', `Completed ${period} analytics aggregation`, {
    docId,
    errorCount: errors.length,
  });

  try {
    await sendNotification({
      title: `AUTOBLOGGER ${period === 'daily' ? 'Daily' : 'Weekly'} Report Ready`,
      body: `Analytics snapshot (${startDate} to ${endDate}) synced. Posts published: ${
        (sources.publishedPostsCount as number) ?? 0
      }.`,
      data: {
        event: 'analytics_synced',
        period,
        snapshotId: docId,
      },
    });
  } catch (err) {
    logger.warn('Failed to send analytics FCM notification', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return summary;
}
