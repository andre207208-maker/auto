import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { withRetry, isTransientHttpStatus } from '../utils/retry.js';

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedAccessToken | null = null;

export async function getGoogleOAuthAccessToken(): Promise<string> {
  if (
    !env.GOOGLE_OAUTH_CLIENT_ID ||
    !env.GOOGLE_OAUTH_CLIENT_SECRET ||
    !env.GOOGLE_OAUTH_REFRESH_TOKEN
  ) {
    throw new AppError(
      'Google OAuth2 credentials are missing. Configure GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REFRESH_TOKEN.',
      503,
      'GOOGLE_OAUTH_NOT_CONFIGURED'
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const tokenData = await withRetry(
    async () => {
      const params = new URLSearchParams({
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      });

      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        const err = new AppError(
          `Google OAuth token refresh failed (${response.status}): ${text}`,
          response.status >= 500 ? 502 : 401,
          'GOOGLE_OAUTH_REFRESH_FAILED'
        );
        if (isTransientHttpStatus(response.status)) {
          throw err;
        }
        throw Object.assign(err, { nonRetryable: true });
      }

      return (await response.json()) as { access_token: string; expires_in: number };
    },
    {
      operationName: 'google_oauth_refresh',
      maxAttempts: 3,
      shouldRetry: (err) => !(err as { nonRetryable?: boolean })?.nonRetryable,
    }
  );

  cachedToken = {
    accessToken: tokenData.access_token,
    expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
  };

  return cachedToken.accessToken;
}
