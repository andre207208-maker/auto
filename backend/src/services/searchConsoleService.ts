import { WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { isTransientHttpStatus, withRetry } from '../utils/retry.js';
import { getGoogleOAuthAccessToken } from './googleAuthService.js';

function resolveSiteUrl(env: WorkerEnv, siteUrl?: string): string {
  const resolved = siteUrl || env.GSC_SITE_URL;
  if (!resolved) {
    throw new AppError(
      'Google Search Console siteUrl is required (pass siteUrl or set GSC_SITE_URL).',
      400,
      'GSC_SITE_URL_MISSING'
    );
  }
  return resolved;
}

async function gscFetch<T>(env: WorkerEnv, url: string, init: RequestInit = {}): Promise<T> {
  const accessToken = await getGoogleOAuthAccessToken(env);

  return withRetry(
    async () => {
      const response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });

      if (!response.ok) {
        const text = await response.text();
        const err = new AppError(
          `Google Search Console API error (${response.status}): ${text}`,
          response.status >= 500 ? 502 : response.status,
          'GSC_API_ERROR'
        );
        if (isTransientHttpStatus(response.status)) {
          throw err;
        }
        throw Object.assign(err, { nonRetryable: true });
      }

      if (response.status === 204) {
        return {} as T;
      }
      return (await response.json()) as T;
    },
    {
      operationName: 'gsc_api_call',
      maxAttempts: 3,
      shouldRetry: (err) => !(err as { nonRetryable?: boolean })?.nonRetryable,
    }
  );
}

export async function querySearchAnalytics(
  env: WorkerEnv,
  params: {
    siteUrl?: string;
    startDate: string;
    endDate: string;
    dimensions?: Array<'query' | 'page' | 'country' | 'device' | 'date'>;
    rowLimit?: number;
  }
): Promise<unknown> {
  const site = resolveSiteUrl(env, params.siteUrl);
  const encodedSite = encodeURIComponent(site);

  return gscFetch(
    env,
    `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
    {
      method: 'POST',
      body: JSON.stringify({
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: params.dimensions || ['query', 'page'],
        rowLimit: params.rowLimit || 50,
      }),
    }
  );
}

export async function listSitemaps(env: WorkerEnv, siteUrl?: string): Promise<unknown> {
  const site = resolveSiteUrl(env, siteUrl);
  const encodedSite = encodeURIComponent(site);
  return gscFetch(env, `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/sitemaps`);
}

export async function submitSitemap(
  env: WorkerEnv,
  feedpath: string,
  siteUrl?: string
): Promise<{ submitted: boolean }> {
  const site = resolveSiteUrl(env, siteUrl);
  const encodedSite = encodeURIComponent(site);
  const encodedFeed = encodeURIComponent(feedpath);
  await gscFetch(
    env,
    `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/sitemaps/${encodedFeed}`,
    { method: 'PUT' }
  );
  return { submitted: true };
}

export async function inspectUrl(
  env: WorkerEnv,
  inspectionUrl: string,
  siteUrl?: string
): Promise<unknown> {
  const site = resolveSiteUrl(env, siteUrl);
  return gscFetch(env, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST',
    body: JSON.stringify({
      inspectionUrl,
      siteUrl: site,
    }),
  });
}
