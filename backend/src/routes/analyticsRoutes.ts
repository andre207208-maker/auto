import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import { getGA4TopPages, runGA4Report } from '../services/ga4Service.js';
import {
  inspectUrl,
  listSitemaps,
  querySearchAnalytics,
  submitSitemap,
} from '../services/searchConsoleService.js';
import { WorkerEnv } from '../types/index.js';
import { analyzePeriodPerformance } from '../workers/analyticsWorker.js';

const analyticsRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
analyticsRoutes.use('*', requireAuth);

const gscQuerySchema = z.object({
  siteUrl: z.string().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dimensions: z.array(z.enum(['query', 'page', 'country', 'device', 'date'])).optional(),
  rowLimit: z.number().int().min(1).max(1000).optional(),
});

const ga4QuerySchema = z.object({
  propertyId: z.string().optional(),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  metrics: z.array(z.string()).optional(),
  dimensions: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

analyticsRoutes.post('/gsc/query', async (c) => {
  const input = gscQuerySchema.parse(await c.req.json());
  const data = await querySearchAnalytics(c.env, input);
  return c.json(data as Record<string, unknown>);
});

analyticsRoutes.get('/gsc/sitemaps', async (c) => {
  const data = await listSitemaps(c.env, c.req.query('siteUrl'));
  return c.json(data as Record<string, unknown>);
});

analyticsRoutes.post('/gsc/sitemaps/submit', async (c) => {
  const body = z
    .object({ feedpath: z.string().url(), siteUrl: z.string().optional() })
    .parse(await c.req.json());
  const result = await submitSitemap(c.env, body.feedpath, body.siteUrl);
  return c.json({
    ...result,
    note: 'Sitemap submitted to Google Search Console. Submission notifies Googlebot of URLs and does not guarantee immediate indexing; verify status via /gsc/inspect.',
  });
});

analyticsRoutes.post('/gsc/inspect', async (c) => {
  const body = z
    .object({ inspectionUrl: z.string().url(), siteUrl: z.string().optional() })
    .parse(await c.req.json());
  const result = await inspectUrl(c.env, body.inspectionUrl, body.siteUrl);
  return c.json(result as Record<string, unknown>);
});

analyticsRoutes.post('/ga4/report', async (c) => {
  const input = ga4QuerySchema.parse(await c.req.json());
  const data = await runGA4Report(c.env, input);
  return c.json(data as Record<string, unknown>);
});

analyticsRoutes.get('/ga4/top-pages', async (c) => {
  const startDate = c.req.query('startDate') || '7daysAgo';
  const endDate = c.req.query('endDate') || 'today';
  const propertyId = c.req.query('propertyId');
  const data = await getGA4TopPages(c.env, { propertyId, startDate, endDate });
  return c.json(data as Record<string, unknown>);
});

analyticsRoutes.get('/insights', async (c) => {
  const daysParam = Number(c.req.query('days') || '7');
  const days = Math.min(Math.max(1, Number.isFinite(daysParam) ? daysParam : 7), 30);
  const analysis = await analyzePeriodPerformance(c.env, days);
  return c.json({
    periodDays: days,
    ...analysis.insights,
    errors: analysis.errors,
  });
});

analyticsRoutes.get('/snapshots', async (c) => {
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(Number(limitParam), 60) : 14;
  const res = await c.env.DB.prepare(
    `SELECT id, period, start_date, end_date, published_posts_count, sources_json, errors_json, generated_at
     FROM analytics_snapshots ORDER BY generated_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<{
      id: string;
      period: string;
      start_date: string;
      end_date: string;
      published_posts_count: number;
      sources_json: string;
      errors_json: string;
      generated_at: string;
    }>();

  return c.json({
    snapshots: res.results.map((r) => ({
      id: r.id,
      period: r.period,
      startDate: r.start_date,
      endDate: r.end_date,
      publishedPostsCount: r.published_posts_count,
      sources: JSON.parse(r.sources_json),
      errors: JSON.parse(r.errors_json),
      generatedAt: r.generated_at,
    })),
  });
});

export default analyticsRoutes;
