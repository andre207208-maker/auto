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

export async function computeContentHash(title: string, htmlContent: string): Promise<string> {
  const normalized = `${title.trim().toLowerCase()}::${stripTags(htmlContent).toLowerCase().slice(0, 4000)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
  canonicalUrl?: string;
  faqItems?: Array<{ question: string; answer: string }>;
  internalLinkTargets?: Array<{ title: string; url: string; primaryKeyword: string }>;
  minQualityWordCount?: number;
}): SEOAuditResult {
  const plain = stripTags(params.htmlContent);
  const words = plain ? plain.split(' ') : [];
  const wordCount = words.length;
  const keywordCount = countOccurrences(plain, params.primaryKeyword);
  const keywordDensityPercent =
    wordCount > 0 ? Number(((keywordCount / wordCount) * 100).toFixed(2)) : 0;

  const h1Count = (params.htmlContent.match(/<h1[\s>]/gi) || []).length;
  const h2Count = (params.htmlContent.match(/<h2[\s>]/gi) || []).length;
  const h3Count = (params.htmlContent.match(/<h3[\s>]/gi) || []).length;

  const imgTags = params.htmlContent.match(/<img\b[^>]*>/gi) || [];
  const imageCount = imgTags.length;
  const imagesMissingAlt = imgTags.filter((tag) => {
    const altMatch = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
    return !altMatch || altMatch[1].trim().length === 0;
  }).length;

  const linkMatches = params.htmlContent.match(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi) || [];
  const internalLinkCount = linkMatches.length;

  const hasFaqSchema = Boolean(params.faqItems && params.faqItems.length > 0);

  let canonicalValid = true;
  if (params.canonicalUrl) {
    try {
      const parsed = new URL(params.canonicalUrl);
      canonicalValid = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      canonicalValid = false;
    }
  }

  const issues: string[] = [];
  const recommendations: string[] = [];
  let score = 100;

  if (params.title.length < 35 || params.title.length > 68) {
    score -= 10;
    issues.push(`Title length (${params.title.length}) should ideally be between 35 and 68 characters.`);
  }
  if (!params.title.toLowerCase().includes(params.primaryKeyword.toLowerCase())) {
    score -= 10;
    recommendations.push('Include the primary keyword naturally in the SEO title.');
  }
  if (params.metaDescription.length < 120 || params.metaDescription.length > 165) {
    score -= 10;
    issues.push(`Meta description length (${params.metaDescription.length}) should be 120-160 characters.`);
  }
  if (wordCount < 600) {
    score -= 18;
    issues.push(`Word count (${wordCount}) is thin for competitive organic ranking.`);
  }
  if (h1Count > 1) {
    score -= 8;
    issues.push(`Multiple H1 tags detected (${h1Count}); reserve H1 for the main Blogger post title.`);
  }
  if (h2Count < 2) {
    score -= 10;
    recommendations.push('Add at least 2-4 structured H2 subheadings.');
  }
  if (imagesMissingAlt > 0) {
    score -= 8;
    issues.push(`${imagesMissingAlt} image(s) are missing descriptive alt text.`);
  }
  if (!canonicalValid) {
    score -= 10;
    issues.push('Canonical URL is malformed; ensure a valid https:// canonical URL.');
  }
  if (keywordDensityPercent > 3.5) {
    score -= 15;
    issues.push(`Keyword stuffing risk detected (${keywordDensityPercent}% density). Keep below 3.0%.`);
  } else if (keywordDensityPercent < 0.3 && wordCount >= 300) {
    score -= 6;
    recommendations.push(`Primary keyword density is low (${keywordDensityPercent}%); aim for 0.6%-2.2%.`);
  }

  // Detect obvious boilerplate / unfinished placeholders
  const hasPlaceholder = /\b(lorem ipsum|insert link here|placeholder text|tbd)\b/i.test(plain);
  if (hasPlaceholder) {
    score -= 25;
    issues.push('Placeholder or boilerplate template markers detected in content.');
  }

  const internalLinkSuggestions: Array<{ title: string; url: string }> = [];
  if (params.internalLinkTargets && params.internalLinkTargets.length > 0) {
    for (const target of params.internalLinkTargets) {
      if (!params.htmlContent.includes(target.url)) {
        internalLinkSuggestions.push({ title: target.title, url: target.url });
      }
      if (internalLinkSuggestions.length >= 4) {
        break;
      }
    }
    if (internalLinkCount === 0 && internalLinkSuggestions.length > 0) {
      score -= 5;
      recommendations.push('Add 1-3 contextual internal links to existing published articles.');
    }
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
    url: params.canonicalUrl,
    faqItems: params.faqItems,
  });

  const structuredDataValid =
    typeof jsonLdSchema['@context'] === 'string' &&
    Boolean(jsonLdSchema['@type'] || jsonLdSchema['@graph']);

  const minWords = params.minQualityWordCount ?? 250;
  const passedQualityGate =
    wordCount >= minWords &&
    !hasPlaceholder &&
    keywordDensityPercent <= 3.5 &&
    imagesMissingAlt === 0 &&
    canonicalValid &&
    structuredDataValid;

  return {
    score: Math.max(0, score),
    passedQualityGate,
    titleLength: params.title.length,
    metaDescriptionLength: params.metaDescription.length,
    wordCount,
    keywordDensityPercent,
    h1Count,
    h2Count,
    h3Count,
    imageCount,
    imagesMissingAlt,
    internalLinkCount,
    canonicalValid,
    structuredDataValid,
    hasFaqSchema,
    issues,
    recommendations,
    internalLinkSuggestions,
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
