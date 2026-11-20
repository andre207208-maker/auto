import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { auditSeo, buildArticleJsonLd, optimizeMetadataWithAI } from '../services/seoService.js';

const router = Router();
router.use(requireAuth);

const auditSchema = z.object({
  title: z.string().min(1).max(300),
  metaDescription: z.string().max(500).default(''),
  htmlContent: z.string().min(1),
  primaryKeyword: z.string().min(1).max(150),
  slug: z.string().max(150).optional(),
  faqItems: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
});

const optimizeSchema = z.object({
  title: z.string().min(1).max(300),
  excerpt: z.string().min(1).max(2000),
  primaryKeyword: z.string().min(1).max(150),
  preferredProvider: z.enum(['gemini', 'openrouter', 'apinex', 'custom']).optional(),
});

const schemaBuilderInput = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  url: z.string().url().optional(),
  authorName: z.string().optional(),
  faqItems: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
});

router.post(
  '/audit',
  asyncHandler(async (req, res) => {
    const input = auditSchema.parse(req.body);
    const audit = auditSeo(input);
    res.json({ audit });
  })
);

router.post(
  '/optimize-metadata',
  asyncHandler(async (req, res) => {
    const input = optimizeSchema.parse(req.body);
    const optimized = await optimizeMetadataWithAI(input);
    res.json({ optimized });
  })
);

router.post(
  '/schema',
  asyncHandler(async (req, res) => {
    const input = schemaBuilderInput.parse(req.body);
    const jsonLd = buildArticleJsonLd(input);
    res.json({ jsonLd });
  })
);

export default router;
