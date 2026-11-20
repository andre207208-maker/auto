import {
  deleteAdConfigRow,
  listAdConfigRows,
  upsertAdConfigRow,
} from '../db/repositories.js';
import { AdsterraPlacementConfig, WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { isTransientHttpStatus, withRetry } from '../utils/retry.js';

async function adsterraFetch<T>(
  env: WorkerEnv,
  path: string,
  query?: Record<string, string>
): Promise<T> {
  if (!env.ADSTERRA_API_KEY) {
    throw new AppError('ADSTERRA_API_KEY is not configured', 503, 'ADSTERRA_NOT_CONFIGURED');
  }

  const base = (env.ADSTERRA_BASE_URL || 'https://api3.adsterratools.com/publisher').replace(/\/+$/, '');
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
    updatedAt: new Date().toISOString(),
  };
  await upsertAdConfigRow(env.DB, payload);
  return payload;
}

export async function deleteAdConfig(env: WorkerEnv, id: string): Promise<void> {
  await deleteAdConfigRow(env.DB, id);
}

export async function injectAdsIntoPostHtml(env: WorkerEnv, html: string): Promise<string> {
  const configs = await listAdConfigs(env);
  const enabledConfigs = configs.filter((c) => c.enabled && c.scriptHtml.trim().length > 0);
  if (enabledConfigs.length === 0) {
    return html;
  }

  let output = html;

  const topAds = enabledConfigs.filter((c) => c.placementType === 'top_banner');
  const midAds = enabledConfigs.filter(
    (c) => c.placementType === 'mid_article' || c.placementType === 'native_banner'
  );
  const bottomAds = enabledConfigs.filter(
    (c) => c.placementType === 'bottom_banner' || c.placementType === 'social_bar'
  );

  if (topAds.length > 0) {
    const topBlock = topAds.map((a) => `<div class="ab-ad-slot ab-ad-top">${a.scriptHtml}</div>`).join('\n');
    output = `${topBlock}\n${output}`;
  }

  if (midAds.length > 0) {
    const paragraphs = output.split('</p>');
    if (paragraphs.length > 3) {
      for (const ad of midAds) {
        const targetIndex = Math.min(
          Math.max(1, ad.insertAfterParagraph ?? Math.floor(paragraphs.length / 2)),
          paragraphs.length - 1
        );
        paragraphs[targetIndex] = `${paragraphs[targetIndex]}</p>\n<div class="ab-ad-slot ab-ad-mid">${ad.scriptHtml}</div>`;
      }
      output = paragraphs.join('</p>').replace(/<\/p><\/p>/g, '</p>');
    } else {
      const midBlock = midAds.map((a) => `<div class="ab-ad-slot ab-ad-mid">${a.scriptHtml}</div>`).join('\n');
      output = `${output}\n${midBlock}`;
    }
  }

  if (bottomAds.length > 0) {
    const bottomBlock = bottomAds
      .map((a) => `<div class="ab-ad-slot ab-ad-bottom">${a.scriptHtml}</div>`)
      .join('\n');
    output = `${output}\n${bottomBlock}`;
  }

  return output;
}
