import { AIProviderName, ResearchTopicResult } from '../types/index.js';
import { aiProviderManager } from './aiProviderManager.js';

function stripMarkdownFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

export async function researchTopic(params: {
  niche: string;
  seedKeyword?: string;
  language?: string;
  targetAudience?: string;
  preferredProvider?: AIProviderName;
}): Promise<ResearchTopicResult> {
  const language = params.language || 'English';
  const prompt = `
Perform deep SEO topic and keyword research for a blog article.
Niche: ${params.niche}
Seed Keyword: ${params.seedKeyword || 'Auto-discover highest opportunity topic in this niche'}
Target Language: ${language}
Target Audience: ${params.targetAudience || 'General readers searching for actionable answers'}

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

  const response = await aiProviderManager.generateWithFailover({
    prompt,
    systemInstruction:
      'You are an expert SEO content strategist. Output valid JSON only with high-intent, evergreen blog research.',
    preferredProvider: params.preferredProvider,
    jsonMode: true,
  });

  const parsed = JSON.parse(stripMarkdownFences(response.text)) as Omit<
    ResearchTopicResult,
    'providerUsed'
  >;

  return {
    ...parsed,
    providerUsed: response.provider,
  };
}
