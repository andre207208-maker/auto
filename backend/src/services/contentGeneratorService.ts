import { AIProviderName, GeneratedArticle, ResearchTopicResult } from '../types/index.js';
import { aiProviderManager } from './aiProviderManager.js';

function stripMarkdownFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 75);
}

export async function generateArticle(params: {
  topic: string;
  primaryKeyword: string;
  secondaryKeywords?: string[];
  outline?: ResearchTopicResult['outline'];
  language?: string;
  tone?: string;
  targetWordCount?: number;
  preferredProvider?: AIProviderName;
}): Promise<GeneratedArticle> {
  const language = params.language || 'English';
  const tone = params.tone || 'Authoritative, helpful, and engaging';
  const targetWordCount = params.targetWordCount || 1300;

  const outlineContext = params.outline?.length
    ? `Follow this structured outline:\n${JSON.stringify(params.outline, null, 2)}`
    : 'Create a logical H2/H3 structure with an introduction, actionable body sections, comparison/checklist, and conclusion.';

  const prompt = `
Write a comprehensive, publication-ready blog post formatted in clean semantic HTML for Google Blogger.
Topic: ${params.topic}
Primary Keyword: ${params.primaryKeyword}
Secondary Keywords: ${(params.secondaryKeywords || []).join(', ')}
Language: ${language}
Tone: ${tone}
Target Word Count: ~${targetWordCount} words

${outlineContext}

Requirements:
- Use semantic HTML tags (<p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <blockquote>). Do NOT include <html>, <head>, or <body> wrapper tags.
- Include natural keyword placement without stuffing.
- Include a helpful FAQ section at the end.
- Return STRICT JSON matching this shape:
{
  "title": "Compelling SEO title (50-65 chars)",
  "slug": "url-friendly-slug",
  "metaDescription": "140-158 char compelling meta description",
  "labels": ["tag1", "tag2", "tag3", "tag4"],
  "htmlContent": "<p>...</p><h2>...</h2>...",
  "plainExcerpt": "2-sentence summary",
  "faqItems": [{"question": "string", "answer": "string"}],
  "imagePrompts": ["descriptive hero image prompt", "supporting diagram prompt"]
}
`;

  const response = await aiProviderManager.generateWithFailover({
    prompt,
    systemInstruction:
      'You are an elite long-form SEO editorial writer. Return valid JSON only. Ensure htmlContent is rich, well-structured, and ready to publish on Blogger.',
    preferredProvider: params.preferredProvider,
    jsonMode: true,
  });

  const parsed = JSON.parse(stripMarkdownFences(response.text)) as Omit<
    GeneratedArticle,
    'wordCount' | 'providerUsed' | 'modelUsed'
  >;

  const plainText = (parsed.htmlContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const wordCount = plainText ? plainText.split(' ').length : 0;

  return {
    title: parsed.title || params.topic,
    slug: toSlug(parsed.slug || parsed.title || params.topic),
    metaDescription: parsed.metaDescription || parsed.plainExcerpt || '',
    labels: Array.isArray(parsed.labels) ? parsed.labels.slice(0, 8) : [],
    htmlContent: parsed.htmlContent || '',
    plainExcerpt: parsed.plainExcerpt || '',
    wordCount,
    faqItems: Array.isArray(parsed.faqItems) ? parsed.faqItems : [],
    imagePrompts: Array.isArray(parsed.imagePrompts) ? parsed.imagePrompts : [],
    providerUsed: response.provider,
    modelUsed: response.model,
  };
}
