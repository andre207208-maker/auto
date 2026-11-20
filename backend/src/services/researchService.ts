import {
  AIProviderName,
  ResearchTopicResult,
  TavilySearchSource,
  WorkerEnv,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { sanitizePlainText } from '../utils/sanitize.js';
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
        query: sanitizePlainText(query, 400),
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

export async function discoverTrendingTopics(
  env: WorkerEnv,
  params: {
    niche: string;
    language?: string;
    count?: number;
    preferredProvider?: AIProviderName;
  }
): Promise<{
  niche: string;
  topics: Array<{
    topic: string;
    primaryKeyword: string;
    searchIntent: 'informational' | 'commercial' | 'transactional' | 'navigational';
    estimatedCompetition: 'low' | 'medium' | 'high';
    whyTrending: string;
  }>;
  sources: TavilySearchSource[];
  providerUsed: AIProviderName;
}> {
  const niche = sanitizePlainText(params.niche, 200);
  const language = sanitizePlainText(params.language || 'English', 60);
  const count = Math.min(Math.max(1, params.count || 5), 10);

  const sources = await searchTavily(env, `${niche} latest trends news updates 2026`, 6);
  const sourceSummary =
    sources.length > 0
      ? `Live Web Sources:\n${sources
          .map((s, idx) => `${idx + 1}. ${s.title} (${s.url}): ${s.content}`)
          .join('\n')}`
      : 'No live web sources available; focus on high-utility evergreen + current niche demand.';

  const prompt = `
Discover ${count} original, high-potential blog topic ideas for the niche "${niche}" in "${language}".
${sourceSummary}

Return STRICT JSON matching this shape:
{
  "topics": [
    {
      "topic": "string",
      "primaryKeyword": "string",
      "searchIntent": "informational | commercial | transactional | navigational",
      "estimatedCompetition": "low | medium | high",
      "whyTrending": "short factual reason"
    }
  ]
}
`;

  const aiRes = await generateWithFailover(env, {
    prompt,
    systemInstruction:
      'You are an SEO trend analyst. Output strict JSON only with practical, non-clickbait topic opportunities.',
    preferredProvider: params.preferredProvider,
    jsonMode: true,
  });

  const parsed = JSON.parse(stripMarkdownFences(aiRes.text)) as {
    topics: Array<{
      topic: string;
      primaryKeyword: string;
      searchIntent: 'informational' | 'commercial' | 'transactional' | 'navigational';
      estimatedCompetition: 'low' | 'medium' | 'high';
      whyTrending: string;
    }>;
  };

  return {
    niche,
    topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, count) : [],
    sources,
    providerUsed: aiRes.provider,
  };
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
  const niche = sanitizePlainText(params.niche, 200);
  const seedKeyword = params.seedKeyword ? sanitizePlainText(params.seedKeyword, 200) : undefined;
  const language = sanitizePlainText(params.language || 'English', 60);
  const query = seedKeyword ? `${seedKeyword} ${niche}` : `${niche} trending topics guide`;

  const tavilySources = await searchTavily(env, query, 5);
  const tavilyContext =
    tavilySources.length > 0
      ? `\nLive Web Research Sources (Tavily):\n${tavilySources
          .map((s, i) => `${i + 1}. ${s.title} (${s.url}): ${s.content}`)
          .join('\n')}`
      : '';

  const prompt = `
Perform deep SEO topic, search intent, and competition research for a helpful, user-first blog article.
Niche: ${niche}
Seed Keyword: ${seedKeyword || 'Auto-discover highest opportunity topic in this niche'}
Target Language: ${language}
Target Audience: ${sanitizePlainText(params.targetAudience || 'General readers searching for actionable answers', 300)}
${tavilyContext}

Return STRICT JSON matching this exact shape (no markdown, no explanation):
{
  "niche": "string",
  "primaryKeyword": "string",
  "secondaryKeywords": ["string", "string", "string", "string", "string"],
  "searchIntent": "informational | commercial | transactional | navigational",
  "competitionAnalysis": "Concise 2-sentence assessment of SERP competition and content angle to differentiate",
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
      'You are an expert SEO content strategist. Output valid JSON only with high-intent, useful blog research.',
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
