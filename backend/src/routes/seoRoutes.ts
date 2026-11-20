import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import { auditSeo, buildArticleJsonLd, optimizeMetadataWithAI } from '../services/seoService.js';
import { WorkerEnv } from '../types/index.js';

const seoRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
seoRoutes.use('*', requireAuth);

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

seoRoutes.post('/audit', async (c) => {
  const input = auditSchema.parse(await c.req.json());
  const audit = auditSeo(input);
  return c.json({ audit });
});

seoRoutes.post('/optimize-metadata', async (c) => {
  const input = optimizeSchema.parse(await c.req.json());
  const optimized = await optimizeMetadataWithAI(c.env, input);
  return c.json({ optimized });
});

seoRoutes.post('/schema', async (c) => {
  const input = schemaBuilderInput.parse(await c.req.json());
  const jsonLd = buildArticleJsonLd(input);
  return c.json({ jsonLd });
});

export default seoRoutes;
