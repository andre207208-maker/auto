import { WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { isTransientHttpStatus, withRetry } from '../utils/retry.js';
import { getGoogleOAuthAccessToken } from './googleAuthService.js';

function resolvePropertyId(env: WorkerEnv, propertyId?: string): string {
  const id = propertyId || env.GA4_PROPERTY_ID;
  if (!id) {
    throw new AppError(
      'GA4 propertyId is required (pass propertyId or set GA4_PROPERTY_ID).',
      400,
      'GA4_PROPERTY_ID_MISSING'
    );
  }
  return id.replace(/^properties\//, '');
}

export async function runGA4Report(
  env: WorkerEnv,
  params: {
    propertyId?: string;
    startDate: string;
    endDate: string;
    metrics?: string[];
    dimensions?: string[];
    limit?: number;
  }
): Promise<unknown> {
  const propId = resolvePropertyId(env, params.propertyId);
  const accessToken = await getGoogleOAuthAccessToken(env);

  const metrics = (params.metrics || ['screenPageViews', 'sessions', 'activeUsers', 'bounceRate']).map(
    (name) => ({ name })
  );
  const dimensions = (params.dimensions || ['date']).map((name) => ({ name }));

  return withRetry(
    async () => {
      const response = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propId)}:runReport`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
            metrics,
            dimensions,
            limit: params.limit || 50,
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        const err = new AppError(
          `GA4 Data API error (${response.status}): ${text}`,
          response.status >= 500 ? 502 : response.status,
          'GA4_API_ERROR'
        );
        if (isTransientHttpStatus(response.status)) {
          throw err;
        }
        throw Object.assign(err, { nonRetryable: true });
      }

      return response.json();
    },
    {
      operationName: 'ga4_run_report',
      maxAttempts: 3,
      shouldRetry: (err) => !(err as { nonRetryable?: boolean })?.nonRetryable,
    }
  );
}

export async function getGA4TopPages(
  env: WorkerEnv,
  params: {
    propertyId?: string;
    startDate: string;
    endDate: string;
    limit?: number;
  }
): Promise<unknown> {
  return runGA4Report(env, {
    propertyId: params.propertyId,
    startDate: params.startDate,
    endDate: params.endDate,
    metrics: ['screenPageViews', 'activeUsers', 'averageSessionDuration'],
    dimensions: ['pagePath', 'pageTitle'],
    limit: params.limit || 25,
  });
}
