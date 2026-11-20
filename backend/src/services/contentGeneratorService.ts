import {
  AIProviderName,
  GeneratedArticle,
  ResearchTopicResult,
  WorkerEnv,
} from '../types/index.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { generateWithFailover } from './aiProviderManager.js';

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

export async function generateArticle(
  env: WorkerEnv,
  params: {
    topic: string;
    primaryKeyword: string;
    secondaryKeywords?: string[];
    outline?: ResearchTopicResult['outline'];
    internalLinkTargets?: Array<{ title: string; url: string; primaryKeyword: string }>;
    language?: string;
    tone?: string;
    targetWordCount?: number;
    preferredProvider?: AIProviderName;
  }
): Promise<GeneratedArticle> {
  const topic = sanitizePlainText(params.topic, 300);
  const primaryKeyword = sanitizePlainText(params.primaryKeyword, 150);
  const language = sanitizePlainText(params.language || 'English', 60);
  const tone = sanitizePlainText(params.tone || 'Authoritative, helpful, and people-first', 200);
  const targetWordCount = Math.min(Math.max(600, params.targetWordCount || 1200), 4000);

  const outlineContext = params.outline?.length
    ? `Follow this structured outline:\n${JSON.stringify(params.outline, null, 2)}`
    : 'Create a logical H2/H3 structure with an introduction, actionable body sections, checklist, and conclusion.';

  const internalLinksContext =
    params.internalLinkTargets && params.internalLinkTargets.length > 0
      ? `\nInternal Linking Targets (naturally embed 1-3 relevant links using <a href="...">anchor text</a> where contextually helpful):\n${params.internalLinkTargets
          .map((t) => `- Title: "${t.title}" | Keyword: "${t.primaryKeyword}" | URL: ${t.url}`)
          .join('\n')}`
      : '';

  const prompt = `
Write a comprehensive, original, people-first blog post formatted in clean semantic HTML for Google Blogger.
Topic: ${topic}
Primary Keyword: ${primaryKeyword}
Secondary Keywords: ${(params.secondaryKeywords || []).join(', ')}
Language: ${language}
Tone: ${tone}
Target Word Count: ~${targetWordCount} words

${outlineContext}
${internalLinksContext}

Strict Editorial & Quality Requirements:
- Use semantic HTML tags (<p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <blockquote>, <a>). Do NOT include <html>, <head>, or <body> wrapper tags.
- Include natural keyword placement without keyword stuffing.
- Never include placeholder text (like "Lorem ipsum", "[Insert link]", "TBD") or fabricate fake statistics/case studies.
- Any <img> tags included must have descriptive alt attributes.
- Include a helpful FAQ section at the end.
- Return STRICT JSON matching this shape:
{
  "title": "Compelling SEO title (45-65 chars)",
  "slug": "url-friendly-slug",
  "metaDescription": "135-158 char compelling meta description",
  "labels": ["tag1", "tag2", "tag3", "tag4"],
  "htmlContent": "<p>...</p><h2>...</h2>...",
  "plainExcerpt": "2-sentence summary",
  "faqItems": [{"question": "string", "answer": "string"}],
  "imagePrompts": ["descriptive hero image prompt", "supporting diagram prompt"]
}
`;

  const response = await generateWithFailover(env, {
    prompt,
    systemInstruction:
      'You are an elite long-form SEO editorial writer. Return valid JSON only. Produce original, accurate, helpful HTML content ready for Blogger.',
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
    title: parsed.title || topic,
    slug: toSlug(parsed.slug || parsed.title || topic),
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
