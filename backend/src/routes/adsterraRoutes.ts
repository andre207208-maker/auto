import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import {
  deleteAdConfig,
  getAdsterraDomains,
  getAdsterraPlacements,
  getAdsterraStats,
  injectAdsIntoPostHtml,
  listAdConfigs,
  upsertAdConfig,
} from '../services/adsterraService.js';
import { WorkerEnv } from '../types/index.js';

const adsterraRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
adsterraRoutes.use('*', requireAuth);

const adConfigSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  placementType: z.enum([
    'top_banner',
    'mid_article',
    'bottom_banner',
    'social_bar',
    'native_banner',
  ]),
  scriptHtml: z.string().min(1).max(5000),
  enabled: z.boolean().default(true),
  insertAfterParagraph: z.number().int().min(1).max(50).optional(),
});

adsterraRoutes.get('/domains', async (c) => {
  const data = await getAdsterraDomains(c.env);
  return c.json(data as Record<string, unknown>);
});

adsterraRoutes.get('/placements', async (c) => {
  const data = await getAdsterraPlacements(c.env);
  return c.json(data as Record<string, unknown>);
});

adsterraRoutes.get('/stats', async (c) => {
  const startDate =
    c.req.query('startDate') || new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const finishDate = c.req.query('finishDate') || new Date().toISOString().slice(0, 10);
  const groupQuery = c.req.query('groupBy');
  const groupBy =
    groupQuery === 'domain' || groupQuery === 'placement' || groupQuery === 'country'
      ? groupQuery
      : 'date';
  const domainId = c.req.query('domainId');

  const data = await getAdsterraStats(c.env, { startDate, finishDate, groupBy, domainId });
  return c.json(data as Record<string, unknown>);
});

adsterraRoutes.get('/configs', async (c) => {
  const configs = await listAdConfigs(c.env);
  return c.json({ configs });
});

adsterraRoutes.post('/configs', async (c) => {
  const input = adConfigSchema.parse(await c.req.json());
  const config = await upsertAdConfig(c.env, input);
  return c.json({ config }, 201);
});

adsterraRoutes.delete('/configs/:id', async (c) => {
  await deleteAdConfig(c.env, c.req.param('id'));
  return c.body(null, 204);
});

adsterraRoutes.post('/preview-inject', async (c) => {
  const body = z.object({ html: z.string().min(1) }).parse(await c.req.json());
  const html = await injectAdsIntoPostHtml(c.env, body.html);
  return c.json({ html });
});

export default adsterraRoutes;
