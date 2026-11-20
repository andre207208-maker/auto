import { AIProviderName, SEOAuditResult, WorkerEnv } from '../types/index.js';
import { generateWithFailover } from './aiProviderManager.js';

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function countOccurrences(text: string, keyword: string): number {
  if (!keyword.trim()) {
    return 0;
  }
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.toLowerCase().match(new RegExp(`\\b${escaped.toLowerCase()}\\b`, 'g'));
  return matches ? matches.length : 0;
}

export function buildArticleJsonLd(params: {
  title: string;
  description: string;
  url?: string;
  authorName?: string;
  faqItems?: Array<{ question: string; answer: string }>;
}): Record<string, unknown> {
  const now = new Date().toISOString();
  const articleSchema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: params.title,
    description: params.description,
    datePublished: now,
    dateModified: now,
    author: {
      '@type': 'Organization',
      name: params.authorName || 'AUTOBLOGGER AI Editorial',
    },
    ...(params.url ? { mainEntityOfPage: params.url } : {}),
  };

  if (params.faqItems && params.faqItems.length > 0) {
    return {
      '@context': 'https://schema.org',
      '@graph': [
        articleSchema,
        {
          '@type': 'FAQPage',
          mainEntity: params.faqItems.map((item) => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: item.answer,
            },
          })),
        },
      ],
    };
  }

  return articleSchema;
}

export function auditSeo(params: {
  title: string;
  metaDescription: string;
  htmlContent: string;
  primaryKeyword: string;
  slug?: string;
  faqItems?: Array<{ question: string; answer: string }>;
}): SEOAuditResult {
  const plain = stripTags(params.htmlContent);
  const words = plain ? plain.split(' ') : [];
  const wordCount = words.length;
  const keywordCount = countOccurrences(plain, params.primaryKeyword);
  const keywordDensityPercent =
    wordCount > 0 ? Number(((keywordCount / wordCount) * 100).toFixed(2)) : 0;

  const h1Count = (params.htmlContent.match(/<h1[\s>]/gi) || []).length;
  const h2Count = (params.htmlContent.match(/<h2[\s>]/gi) || []).length;
  const hasFaqSchema = Boolean(params.faqItems && params.faqItems.length > 0);

  const issues: string[] = [];
  const recommendations: string[] = [];
  let score = 100;

  if (params.title.length < 35 || params.title.length > 68) {
    score -= 10;
    issues.push(`Title length (${params.title.length}) should ideally be between 35 and 68 characters.`);
  }
  if (!params.title.toLowerCase().includes(params.primaryKeyword.toLowerCase())) {
    score -= 12;
    recommendations.push('Include the primary keyword naturally in the SEO title.');
  }
  if (params.metaDescription.length < 120 || params.metaDescription.length > 165) {
    score -= 10;
    issues.push(`Meta description length (${params.metaDescription.length}) should be 120-160 characters.`);
  }
  if (wordCount < 600) {
    score -= 15;
    issues.push(`Word count (${wordCount}) is thin for competitive organic ranking.`);
  }
  if (h2Count < 2) {
    score -= 10;
    recommendations.push('Add at least 2-4 structured H2 subheadings.');
  }
  if (keywordDensityPercent < 0.4 || keywordDensityPercent > 3.0) {
    score -= 8;
    recommendations.push(`Adjust primary keyword density (currently ${keywordDensityPercent}%) to 0.6%-2.2%.`);
  }

  const cleanSlug = (params.slug || params.title)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 75);

  const jsonLdSchema = buildArticleJsonLd({
    title: params.title,
    description: params.metaDescription,
    faqItems: params.faqItems,
  });

  return {
    score: Math.max(0, score),
    titleLength: params.title.length,
    metaDescriptionLength: params.metaDescription.length,
    wordCount,
    keywordDensityPercent,
    h1Count,
    h2Count,
    hasFaqSchema,
    issues,
    recommendations,
    optimizedMetaTitle: params.title,
    optimizedMetaDescription: params.metaDescription,
    optimizedSlug: cleanSlug,
    jsonLdSchema,
  };
}

export async function optimizeMetadataWithAI(
  env: WorkerEnv,
  params: {
    title: string;
    excerpt: string;
    primaryKeyword: string;
    preferredProvider?: AIProviderName;
  }
): Promise<{ metaTitle: string; metaDescription: string; slug: string; labels: string[] }> {
  const prompt = `
Optimize SEO metadata for this article:
Current Title: ${params.title}
Primary Keyword: ${params.primaryKeyword}
Excerpt: ${params.excerpt}

Return strict JSON:
{
  "metaTitle": "50-62 chars with keyword",
  "metaDescription": "135-156 chars with CTA and keyword",
  "slug": "short-seo-slug",
  "labels": ["label1", "label2", "label3", "label4"]
}
`;

  const response = await generateWithFailover(env, {
    prompt,
    systemInstruction: 'Return valid JSON only for technical SEO optimization.',
    preferredProvider: params.preferredProvider,
    jsonMode: true,
  });

  const clean = response.text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  return JSON.parse(clean) as {
    metaTitle: string;
    metaDescription: string;
    slug: string;
    labels: string[];
  };
}

export function appendJsonLdToHtml(html: string, jsonLd: Record<string, unknown>): string {
  const scriptTag = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
  return `${html}\n${scriptTag}`;
}
