import { logSystemEvent } from '../db/repositories.js';
import { getAdsterraStats } from '../services/adsterraService.js';
import { sendNotification } from '../services/fcmService.js';
import { runGA4Report } from '../services/ga4Service.js';
import { inspectUrl, querySearchAnalytics } from '../services/searchConsoleService.js';
import { WorkerEnv } from '../types/index.js';
import { logger } from '../utils/logger.js';

function formatDateDaysAgo(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

interface GscRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

interface GscResponse {
  rows?: GscRow[];
}

interface Ga4Response {
  rows?: Array<{
    metricValues?: Array<{ value?: string }>;
  }>;
}

function sumGa4Metrics(report: Ga4Response): { pageViews: number; sessions: number; activeUsers: number } {
  let pageViews = 0;
  let sessions = 0;
  let activeUsers = 0;
  for (const row of report.rows || []) {
    pageViews += Number(row.metricValues?.[0]?.value || 0);
    sessions += Number(row.metricValues?.[1]?.value || 0);
    activeUsers += Number(row.metricValues?.[2]?.value || 0);
  }
  return { pageViews, sessions, activeUsers };
}

export interface TrafficComparisonInsights {
  trafficChangePercent: number | null;
  gscClicksDelta: number | null;
  gscImpressionsDelta: number | null;
  trafficDropReasons: string[];
  pagesLosingTraffic: Array<{ page: string; previousClicks: number; currentClicks: number; delta: number }>;
  keywordsLosingImpressions: Array<{
    query: string;
    previousImpressions: number;
    currentImpressions: number;
    delta: number;
  }>;
  pagesNeedingUpdate: Array<{ title: string; url: string; reason: string }>;
  indexingIssues: Array<{ url: string; verdict: string; coverageState: string }>;
  recommendations: string[];
}

export async function analyzePeriodPerformance(
  env: WorkerEnv,
  days: number
): Promise<{
  insights: TrafficComparisonInsights;
  ga4Current?: unknown;
  ga4Previous?: unknown;
  gscCurrent?: unknown;
  gscPrevious?: unknown;
  errors: Array<{ source: string; message: string }>;
}> {
  const currentStart = formatDateDaysAgo(days);
  const currentEnd = formatDateDaysAgo(0);
  const prevStart = formatDateDaysAgo(days * 2);
  const prevEnd = formatDateDaysAgo(days + 1);

  const errors: Array<{ source: string; message: string }> = [];
  const trafficDropReasons: string[] = [];
  const recommendations: string[] = [];
  let trafficChangePercent: number | null = null;
  let gscClicksDelta: number | null = null;
  let gscImpressionsDelta: number | null = null;

  let ga4Current: Ga4Response | undefined;
  let ga4Previous: Ga4Response | undefined;
  let gscCurrent: unknown;
  let gscPrevious: unknown;

  // 1. GA4 period-over-period comparison
  try {
    const [cur, prev] = await Promise.all([
      runGA4Report(env, { startDate: currentStart, endDate: currentEnd }) as Promise<Ga4Response>,
      runGA4Report(env, { startDate: prevStart, endDate: prevEnd }) as Promise<Ga4Response>,
    ]);
    ga4Current = cur;
    ga4Previous = prev;
    const curTotals = sumGa4Metrics(cur);
    const prevTotals = sumGa4Metrics(prev);
    if (prevTotals.sessions > 0) {
      trafficChangePercent = Number(
        (((curTotals.sessions - prevTotals.sessions) / prevTotals.sessions) * 100).toFixed(2)
      );
      if (trafficChangePercent <= -10) {
        trafficDropReasons.push(
          `GA4 sessions declined by ${Math.abs(trafficChangePercent)}% (${prevTotals.sessions} -> ${curTotals.sessions}).`
        );
      }
    }
  } catch (err) {
    errors.push({ source: 'ga4', message: err instanceof Error ? err.message : String(err) });
  }

  // 2. Search Console query + page deltas
  const pagesLosingTraffic: TrafficComparisonInsights['pagesLosingTraffic'] = [];
  const keywordsLosingImpressions: TrafficComparisonInsights['keywordsLosingImpressions'] = [];

  try {
    const [curPages, prevPages, curQueries, prevQueries] = await Promise.all([
      querySearchAnalytics(env, {
        startDate: currentStart,
        endDate: currentEnd,
        dimensions: ['page'],
        rowLimit: 50,
      }) as Promise<GscResponse>,
      querySearchAnalytics(env, {
        startDate: prevStart,
        endDate: prevEnd,
        dimensions: ['page'],
        rowLimit: 50,
      }) as Promise<GscResponse>,
      querySearchAnalytics(env, {
        startDate: currentStart,
        endDate: currentEnd,
        dimensions: ['query'],
        rowLimit: 50,
      }) as Promise<GscResponse>,
      querySearchAnalytics(env, {
        startDate: prevStart,
        endDate: prevEnd,
        dimensions: ['query'],
        rowLimit: 50,
      }) as Promise<GscResponse>,
    ]);

    gscCurrent = { pages: curPages.rows || [], queries: curQueries.rows || [] };
    gscPrevious = { pages: prevPages.rows || [], queries: prevQueries.rows || [] };

    const curPageMap = new Map((curPages.rows || []).map((r) => [r.keys?.[0] || '', r]));
    let totalCurClicks = 0;
    let totalPrevClicks = 0;
    for (const r of curPages.rows || []) {
      totalCurClicks += r.clicks || 0;
    }
    for (const prev of prevPages.rows || []) {
      const pageUrl = prev.keys?.[0] || '';
      const prevClicks = prev.clicks || 0;
      totalPrevClicks += prevClicks;
      const curClicks = curPageMap.get(pageUrl)?.clicks || 0;
      const delta = curClicks - prevClicks;
      if (pageUrl && delta < 0) {
        pagesLosingTraffic.push({
          page: pageUrl,
          previousClicks: prevClicks,
          currentClicks: curClicks,
          delta,
        });
      }
    }
    pagesLosingTraffic.sort((a, b) => a.delta - b.delta);

    const curQueryMap = new Map((curQueries.rows || []).map((r) => [r.keys?.[0] || '', r]));
    let totalCurImpr = 0;
    let totalPrevImpr = 0;
    for (const r of curQueries.rows || []) {
      totalCurImpr += r.impressions || 0;
    }
    for (const prev of prevQueries.rows || []) {
      const queryText = prev.keys?.[0] || '';
      const prevImpr = prev.impressions || 0;
      totalPrevImpr += prevImpr;
      const curImpr = curQueryMap.get(queryText)?.impressions || 0;
      const delta = curImpr - prevImpr;
      if (queryText && delta < 0) {
        keywordsLosingImpressions.push({
          query: queryText,
          previousImpressions: prevImpr,
          currentImpressions: curImpr,
          delta,
        });
      }
    }
    keywordsLosingImpressions.sort((a, b) => a.delta - b.delta);

    gscClicksDelta = totalCurClicks - totalPrevClicks;
    gscImpressionsDelta = totalCurImpr - totalPrevImpr;

    if (gscClicksDelta < 0) {
      trafficDropReasons.push(
        `Search Console organic clicks dropped by ${Math.abs(gscClicksDelta)} compared to the previous ${days}-day period.`
      );
    }
    if (gscImpressionsDelta < 0) {
      trafficDropReasons.push(
        `Search Console impressions declined by ${Math.abs(gscImpressionsDelta)} across tracked keywords.`
      );
    }
  } catch (err) {
    errors.push({
      source: 'search_console',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Identify pages needing updates & check indexing state honestly via GSC URL Inspection
  const pagesNeedingUpdate: TrafficComparisonInsights['pagesNeedingUpdate'] = [];
  const indexingIssues: TrafficComparisonInsights['indexingIssues'] = [];

  try {
    const postRows = await env.DB.prepare(
      `SELECT title, blogger_url, seo_score, word_count, published_at
       FROM posts
       WHERE is_draft = 0
       ORDER BY published_at ASC
       LIMIT 10`
    ).all<{
      title: string;
      blogger_url: string;
      seo_score: number;
      word_count: number;
      published_at: string;
    }>();

    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
    for (const p of postRows.results) {
      if (p.seo_score < 75 || p.word_count < 600) {
        pagesNeedingUpdate.push({
          title: p.title,
          url: p.blogger_url,
          reason: `Low SEO score (${p.seo_score}/100) or thin depth (${p.word_count} words).`,
        });
      } else if (Date.parse(p.published_at) < thirtyDaysAgo) {
        pagesNeedingUpdate.push({
          title: p.title,
          url: p.blogger_url,
          reason: 'Published >30 days ago; refresh stats, FAQs, and internal links.',
        });
      }
    }

    // Check up to 3 URLs via GSC URL Inspection (never assume submitted == indexed)
    if (env.GSC_SITE_URL && env.GOOGLE_OAUTH_REFRESH_TOKEN) {
      for (const p of postRows.results.slice(0, 3)) {
        if (!p.blogger_url) continue;
        try {
          const insp = (await inspectUrl(env, p.blogger_url)) as {
            inspectionResult?: {
              indexStatusResult?: { verdict?: string; coverageState?: string };
            };
          };
          const verdict = insp.inspectionResult?.indexStatusResult?.verdict || 'VERDICT_UNSPECIFIED';
          const coverageState =
            insp.inspectionResult?.indexStatusResult?.coverageState || 'Unknown';
          if (verdict !== 'PASS') {
            indexingIssues.push({
              url: p.blogger_url,
              verdict,
              coverageState,
            });
          }
        } catch {
          // Non-fatal per URL
        }
      }
    }
  } catch (err) {
    errors.push({ source: 'posts_audit', message: err instanceof Error ? err.message : String(err) });
  }

  if (pagesLosingTraffic.length > 0) {
    recommendations.push(
      `Refresh top losing pages (${pagesLosingTraffic
        .slice(0, 3)
        .map((p) => p.page)
        .join(', ')}) with updated titles, FAQ sections, and internal links.`
    );
  }
  if (keywordsLosingImpressions.length > 0) {
    recommendations.push(
      `Re-target declining queries (${keywordsLosingImpressions
        .slice(0, 3)
        .map((q) => `"${q.query}"`)
        .join(', ')}) by adding dedicated H2 subsections and clearer search-intent answers.`
    );
  }
  if (indexingIssues.length > 0) {
    recommendations.push(
      `${indexingIssues.length} inspected URL(s) are not currently indexed (verdict != PASS). Verify canonical tags, internal links, and thin-content issues rather than assuming sitemap submission guarantees indexing.`
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Maintain steady publishing cadence, strengthen internal links between related articles, and monitor GSC URL Inspection verdicts.'
    );
  }

  return {
    insights: {
      trafficChangePercent,
      gscClicksDelta,
      gscImpressionsDelta,
      trafficDropReasons,
      pagesLosingTraffic: pagesLosingTraffic.slice(0, 10),
      keywordsLosingImpressions: keywordsLosingImpressions.slice(0, 10),
      pagesNeedingUpdate: pagesNeedingUpdate.slice(0, 10),
      indexingIssues,
      recommendations,
    },
    ga4Current,
    ga4Previous,
    gscCurrent,
    gscPrevious,
    errors,
  };
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

  // 2. Period-over-period GA4 + GSC comparison & actionable insights
  const comparison = await analyzePeriodPerformance(env, days);
  sources.ga4 = comparison.ga4Current ?? null;
  sources.ga4Previous = comparison.ga4Previous ?? null;
  sources.searchConsole = comparison.gscCurrent ?? null;
  sources.searchConsolePrevious = comparison.gscPrevious ?? null;
  sources.insights = comparison.insights;
  errors.push(...comparison.errors);

  // 3. Adsterra revenue & impressions
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
    trafficChangePercent: comparison.insights.trafficChangePercent,
  });

  try {
    await sendNotification(env, {
      title: `AUTOBLOGGER ${period === 'daily' ? 'Daily' : 'Weekly'} Report Ready`,
      body: `Analytics (${startDate} to ${endDate}) synced. Posts: ${publishedPostsCount}. Insights ready.`,
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
    insights: comparison.insights,
    sources,
    errors,
    generatedAt,
  };
}

export async function runSeoAuditBatchJob(env: WorkerEnv): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `SELECT id, title, blogger_url, seo_score, word_count FROM posts ORDER BY last_audited_at ASC LIMIT 20`
  ).all<{
    id: string;
    title: string;
    blogger_url: string;
    seo_score: number;
    word_count: number;
  }>();

  const flagged = res.results.filter((p) => p.seo_score < 75 || p.word_count < 600);
  await env.DB.prepare(
    `UPDATE posts SET last_audited_at = ? WHERE id IN (SELECT id FROM posts ORDER BY last_audited_at ASC LIMIT 20)`
  )
    .bind(now)
    .run();

  await logSystemEvent(env.DB, 'info', 'seo_audit_batch', 'Completed scheduled SEO batch audit', {
    checked: res.results.length,
    flaggedCount: flagged.length,
  });

  return {
    checkedCount: res.results.length,
    flaggedPosts: flagged,
    auditedAt: now,
  };
}

export async function runContentUpdateCheckJob(env: WorkerEnv): Promise<Record<string, unknown>> {
  const cutoffIso = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const res = await env.DB.prepare(
    `SELECT id, title, blogger_url, seo_score, published_at
     FROM posts
     WHERE is_draft = 0 AND published_at < ?
     ORDER BY published_at ASC
     LIMIT 15`
  )
    .bind(cutoffIso)
    .all<{
      id: string;
      title: string;
      blogger_url: string;
      seo_score: number;
      published_at: string;
    }>();

  await logSystemEvent(
    env.DB,
    'info',
    'content_update_check',
    `Identified ${res.results.length} older articles for potential content refresh`,
    { count: res.results.length }
  );

  return {
    candidates: res.results,
    checkedAt: new Date().toISOString(),
  };
}
