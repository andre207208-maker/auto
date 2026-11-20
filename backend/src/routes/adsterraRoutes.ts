import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  deleteAdConfig,
  getAdsterraDomains,
  getAdsterraPlacements,
  getAdsterraStats,
  injectAdsIntoPostHtml,
  listAdConfigs,
  upsertAdConfig,
} from '../services/adsterraService.js';

const router = Router();
router.use(requireAuth);

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

router.get(
  '/domains',
  asyncHandler(async (_req, res) => {
    const data = await getAdsterraDomains();
    res.json(data);
  })
);

router.get(
  '/placements',
  asyncHandler(async (_req, res) => {
    const data = await getAdsterraPlacements();
    res.json(data);
  })
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const startDate =
      typeof req.query.startDate === 'string'
        ? req.query.startDate
        : new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const finishDate =
      typeof req.query.finishDate === 'string'
        ? req.query.finishDate
        : new Date().toISOString().slice(0, 10);
    const groupBy =
      req.query.groupBy === 'domain' ||
      req.query.groupBy === 'placement' ||
      req.query.groupBy === 'country'
        ? req.query.groupBy
        : 'date';
    const domainId = typeof req.query.domainId === 'string' ? req.query.domainId : undefined;

    const data = await getAdsterraStats({ startDate, finishDate, groupBy, domainId });
    res.json(data);
  })
);

router.get(
  '/configs',
  asyncHandler(async (_req, res) => {
    const configs = await listAdConfigs();
    res.json({ configs });
  })
);

router.post(
  '/configs',
  asyncHandler(async (req, res) => {
    const input = adConfigSchema.parse(req.body);
    const saved = await upsertAdConfig(input);
    res.status(201).json({ config: saved });
  })
);

router.delete(
  '/configs/:id',
  asyncHandler(async (req, res) => {
    await deleteAdConfig(req.params.id);
    res.status(204).send();
  })
);

router.post(
  '/preview-inject',
  asyncHandler(async (req, res) => {
    const body = z.object({ html: z.string().min(1) }).parse(req.body);
    const injectedHtml = await injectAdsIntoPostHtml(body.html);
    res.json({ html: injectedHtml });
  })
);

export default router;
