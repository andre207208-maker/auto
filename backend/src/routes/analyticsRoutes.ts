import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../config/firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { COLLECTIONS } from '../services/firestoreService.js';
import { getGA4TopPages, runGA4Report } from '../services/ga4Service.js';
import {
  inspectUrl,
  listSitemaps,
  querySearchAnalytics,
  submitSitemap,
} from '../services/searchConsoleService.js';

const router = Router();
router.use(requireAuth);

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

router.post(
  '/gsc/query',
  asyncHandler(async (req, res) => {
    const input = gscQuerySchema.parse(req.body);
    const data = await querySearchAnalytics(input);
    res.json(data);
  })
);

router.get(
  '/gsc/sitemaps',
  asyncHandler(async (req, res) => {
    const siteUrl = typeof req.query.siteUrl === 'string' ? req.query.siteUrl : undefined;
    const data = await listSitemaps(siteUrl);
    res.json(data);
  })
);

router.post(
  '/gsc/sitemaps/submit',
  asyncHandler(async (req, res) => {
    const body = z.object({ feedpath: z.string().url(), siteUrl: z.string().optional() }).parse(req.body);
    const result = await submitSitemap(body.feedpath, body.siteUrl);
    res.json(result);
  })
);

router.post(
  '/gsc/inspect',
  asyncHandler(async (req, res) => {
    const body = z.object({ inspectionUrl: z.string().url(), siteUrl: z.string().optional() }).parse(req.body);
    const result = await inspectUrl(body.inspectionUrl, body.siteUrl);
    res.json(result);
  })
);

router.post(
  '/ga4/report',
  asyncHandler(async (req, res) => {
    const input = ga4QuerySchema.parse(req.body);
    const data = await runGA4Report(input);
    res.json(data);
  })
);

router.get(
  '/ga4/top-pages',
  asyncHandler(async (req, res) => {
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '7daysAgo';
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : 'today';
    const propertyId = typeof req.query.propertyId === 'string' ? req.query.propertyId : undefined;
    const data = await getGA4TopPages({ propertyId, startDate, endDate });
    res.json(data);
  })
);

router.get(
  '/snapshots',
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 60) : 14;
    const snap = await getDb()
      .collection(COLLECTIONS.ANALYTICS_SNAPSHOTS)
      .orderBy('generatedAt', 'desc')
      .limit(limit)
      .get();

    res.json({
      snapshots: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    });
  })
);

export default router;
