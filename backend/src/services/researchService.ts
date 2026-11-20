import {
  AIProviderName,
  ResearchTopicResult,
  TavilySearchSource,
  WorkerEnv,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { generateWithFailover } from './aiProviderManager.js';

function stripMarkdownFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

export async function searchTavily(
  env: WorkerEnv,
  query: string,
  maxResults = 5
): Promise<TavilySearchSource[]> {
  if (!env.TAVILY_API_KEY) {
    return [];
  }

  const baseUrl = (env.TAVILY_BASE_URL || 'https://api.tavily.com').replace(/\/+$/, '');
  try {
    const response = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.warn('Tavily research call failed; continuing with AI research only', {
        status: response.status,
        error: errText.slice(0, 200),
      });
      return [];
    }

    const data = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
    };

    return (data.results || []).map((r) => ({
      title: r.title || 'Untitled source',
      url: r.url || '',
      content: (r.content || '').slice(0, 400),
      score: r.score,
    }));
  } catch (err) {
    logger.warn('Tavily network error; continuing with AI research only', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function researchTopic(
  env: WorkerEnv,
  params: {
    niche: string;
    seedKeyword?: string;
    language?: string;
    targetAudience?: string;
    preferredProvider?: AIProviderName;
  }
): Promise<ResearchTopicResult> {
  const language = params.language || 'English';
  const query = params.seedKeyword
    ? `${params.seedKeyword} ${params.niche}`
    : `${params.niche} trending topics guide`;

  const tavilySources = await searchTavily(env, query, 5);
  const tavilyContext =
    tavilySources.length > 0
      ? `\nLive Web Research Sources (Tavily):\n${tavilySources
          .map((s, i) => `${i + 1}. ${s.title} (${s.url}): ${s.content}`)
          .join('\n')}`
      : '';

  const prompt = `
Perform deep SEO topic and keyword research for a blog article.
Niche: ${params.niche}
Seed Keyword: ${params.seedKeyword || 'Auto-discover highest opportunity topic in this niche'}
Target Language: ${language}
Target Audience: ${params.targetAudience || 'General readers searching for actionable answers'}
${tavilyContext}

Return STRICT JSON matching this exact shape (no markdown, no explanation):
{
  "niche": "string",
  "primaryKeyword": "string",
  "secondaryKeywords": ["string", "string", "string", "string", "string"],
  "searchIntent": "informational | commercial | transactional | navigational",
  "suggestedTitles": ["string", "string", "string"],
  "outline": [
    {
      "heading": "string",
      "subheadings": ["string", "string"],
      "keyPoints": ["string", "string"]
    }
  ],
  "faqQuestions": ["string", "string", "string", "string"],
  "estimatedDifficulty": "low | medium | high"
}
`;

  const response = await generateWithFailover(env, {
    prompt,
    systemInstruction:
      'You are an expert SEO content strategist. Output valid JSON only with high-intent, evergreen blog research.',
    preferredProvider: params.preferredProvider,
    jsonMode: true,
  });

  const parsed = JSON.parse(stripMarkdownFences(response.text)) as Omit<
    ResearchTopicResult,
    'providerUsed' | 'tavilySources'
  >;

  return {
    ...parsed,
    providerUsed: response.provider,
    tavilySources,
  };
}
