import {
  deleteAdConfigRow,
  listAdConfigRows,
  upsertAdConfigRow,
} from '../db/repositories.js';
import { AdDeviceTarget, AdsterraPlacementConfig, WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { isTransientHttpStatus, withRetry } from '../utils/retry.js';

export interface ArticleStructureAnalysis {
  wordCount: number;
  paragraphCount: number;
  headingCount: number;
  maxRecommendedAds: number;
}

export function analyzeArticleStructure(html: string): ArticleStructureAnalysis {
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const wordCount = plain ? plain.split(' ').length : 0;
  const paragraphCount = (html.match(/<\/p>/gi) || []).length;
  const headingCount = (html.match(/<h[23][\s>]/gi) || []).length;

  // Ad density guardrail: never exceed ~1 inline/banner ad per 250 words, capped at 5 max
  let maxRecommendedAds = 1;
  if (wordCount >= 1400) {
    maxRecommendedAds = 5;
  } else if (wordCount >= 900) {
    maxRecommendedAds = 4;
  } else if (wordCount >= 550) {
    maxRecommendedAds = 3;
  } else if (wordCount >= 250) {
    maxRecommendedAds = 2;
  }

  return {
    wordCount,
    paragraphCount,
    headingCount,
    maxRecommendedAds,
  };
}

function wrapAdContainer(
  slotClass: string,
  deviceTarget: AdDeviceTarget,
  scriptHtml: string
): string {
  const deviceClass =
    deviceTarget === 'desktop'
      ? 'ab-device-desktop'
      : deviceTarget === 'mobile'
        ? 'ab-device-mobile'
        : 'ab-device-all';
  return `<div class="ab-ad-slot ${slotClass} ${deviceClass}" data-device-target="${deviceTarget}">${scriptHtml}</div>`;
}

async function adsterraFetch<T>(
  env: WorkerEnv,
  path: string,
  query?: Record<string, string>
): Promise<T> {
  if (!env.ADSTERRA_API_KEY) {
    throw new AppError('ADSTERRA_API_KEY is not configured', 503, 'ADSTERRA_NOT_CONFIGURED');
  }

  const base = (env.ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher').replace(
    /\/+$/,
    ''
  );
  const url = new URL(`${base}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v) {
        url.searchParams.set(k, v);
      }
    }
  }

  return withRetry(
    async () => {
      const response = await fetch(url.toString(), {
        headers: {
          'X-API-Key': env.ADSTERRA_API_KEY!,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        const err = new AppError(
          `Adsterra API error (${response.status}): ${text}`,
          response.status >= 500 ? 502 : response.status,
          'ADSTERRA_API_ERROR'
        );
        if (isTransientHttpStatus(response.status)) {
          throw err;
        }
        throw Object.assign(err, { nonRetryable: true });
      }

      return (await response.json()) as T;
    },
    {
      operationName: 'adsterra_api_call',
      maxAttempts: 3,
      shouldRetry: (err) => !(err as { nonRetryable?: boolean })?.nonRetryable,
    }
  );
}

export async function getAdsterraDomains(env: WorkerEnv): Promise<unknown> {
  return adsterraFetch(env, '/domains.json');
}

export async function getAdsterraPlacements(env: WorkerEnv): Promise<unknown> {
  return adsterraFetch(env, '/placements.json');
}

export async function getAdsterraStats(
  env: WorkerEnv,
  params: {
    startDate: string;
    finishDate: string;
    groupBy?: 'date' | 'domain' | 'placement' | 'country';
    domainId?: string;
  }
): Promise<unknown> {
  return adsterraFetch(env, '/stats.json', {
    start_date: params.startDate,
    finish_date: params.finishDate,
    group_by: params.groupBy || 'date',
    ...(params.domainId ? { domain: params.domainId } : {}),
  });
}

export async function listAdConfigs(env: WorkerEnv): Promise<AdsterraPlacementConfig[]> {
  return listAdConfigRows(env.DB);
}

export async function upsertAdConfig(
  env: WorkerEnv,
  config: Omit<AdsterraPlacementConfig, 'updatedAt'>
): Promise<AdsterraPlacementConfig> {
  const payload: AdsterraPlacementConfig = {
    ...config,
    deviceTarget: config.deviceTarget || 'all',
    updatedAt: new Date().toISOString(),
  };
  await upsertAdConfigRow(env.DB, payload);
  return payload;
}

export async function deleteAdConfig(env: WorkerEnv, id: string): Promise<void> {
  await deleteAdConfigRow(env.DB, id);
}

/**
 * Safely embeds enabled Adsterra placement snippets into Blogger article HTML
 * according to article structure & density caps. Never executes ad scripts server-side.
 */
export async function injectAdsIntoPostHtml(
  env: WorkerEnv,
  html: string,
  targetDevice?: AdDeviceTarget
): Promise<string> {
  const configs = await listAdConfigs(env);
  const enabledConfigs = configs.filter((c) => {
    if (!c.enabled || c.scriptHtml.trim().length === 0) {
      return false;
    }
    if (targetDevice && targetDevice !== 'all' && c.deviceTarget !== 'all') {
      return c.deviceTarget === targetDevice;
    }
    return true;
  });

  if (enabledConfigs.length === 0) {
    return html;
  }

  const structure = analyzeArticleStructure(html);
  let remainingAdBudget = structure.maxRecommendedAds;
  let output = html;

  const topAds = enabledConfigs.filter((c) => c.placementType === 'top_banner');
  const sectionAds = enabledConfigs.filter((c) => c.placementType === 'between_sections');
  const inArticleAds = enabledConfigs.filter(
    (c) =>
      c.placementType === 'in_article' ||
      c.placementType === 'mid_article' ||
      c.placementType === 'native_banner'
  );
  const bottomAds = enabledConfigs.filter(
    (c) =>
      c.placementType === 'end_of_article' ||
      c.placementType === 'bottom_banner' ||
      c.placementType === 'social_bar'
  );

  // 1. Top banner
  if (topAds.length > 0 && remainingAdBudget > 0) {
    const allowedTop = topAds.slice(0, Math.min(1, remainingAdBudget));
    remainingAdBudget -= allowedTop.length;
    const topBlock = allowedTop
      .map((a) => wrapAdContainer('ab-ad-top', a.deviceTarget, a.scriptHtml))
      .join('\n');
    output = `${topBlock}\n${output}`;
  }

  // 2. Between sections (right before H2 headings after the first section)
  if (sectionAds.length > 0 && remainingAdBudget > 0 && structure.headingCount >= 2) {
    let h2Index = 0;
    const targetH2Offset = 2; // Place before 2nd <h2>
    output = output.replace(/<h2\b/gi, (match) => {
      h2Index += 1;
      if (h2Index === targetH2Offset && remainingAdBudget > 0) {
        const ad = sectionAds[0];
        remainingAdBudget -= 1;
        return `${wrapAdContainer('ab-ad-section', ad.deviceTarget, ad.scriptHtml)}\n${match}`;
      }
      return match;
    });
  }

  // 3. In-article / mid-article placements
  if (inArticleAds.length > 0 && remainingAdBudget > 0) {
    const paragraphs = output.split('</p>');
    if (paragraphs.length > 3) {
      const allowedMid = inArticleAds.slice(0, remainingAdBudget);
      for (let i = 0; i < allowedMid.length; i++) {
        const ad = allowedMid[i];
        const defaultPos = Math.floor(((i + 1) * paragraphs.length) / (allowedMid.length + 1));
        const targetIndex = Math.min(
          Math.max(1, ad.insertAfterParagraph ?? defaultPos),
          paragraphs.length - 1
        );
        paragraphs[targetIndex] = `${paragraphs[targetIndex]}</p>\n${wrapAdContainer(
          'ab-ad-in-article',
          ad.deviceTarget,
          ad.scriptHtml
        )}`;
        remainingAdBudget -= 1;
      }
      output = paragraphs.join('</p>').replace(/<\/p><\/p>/g, '</p>');
    }
  }

  // 4. End-of-article / bottom banner / social bar
  if (bottomAds.length > 0 && remainingAdBudget > 0) {
    const allowedBottom = bottomAds.slice(0, Math.min(2, remainingAdBudget));
    const bottomBlock = allowedBottom
      .map((a) => wrapAdContainer(`ab-ad-${a.placementType}`, a.deviceTarget, a.scriptHtml))
      .join('\n');
    output = `${output}\n${bottomBlock}`;
  }

  return output;
}
