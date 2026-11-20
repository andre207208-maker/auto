import { WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { isTransientHttpStatus, withRetry } from '../utils/retry.js';

export async function getGoogleOAuthAccessToken(env: WorkerEnv): Promise<string> {
  if (
    !env.GOOGLE_OAUTH_CLIENT_ID ||
    !env.GOOGLE_OAUTH_CLIENT_SECRET ||
    !env.GOOGLE_OAUTH_REFRESH_TOKEN
  ) {
    throw new AppError(
      'Google OAuth2 credentials are missing. Configure GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REFRESH_TOKEN secrets.',
      503,
      'GOOGLE_OAUTH_NOT_CONFIGURED'
    );
  }

  // Check D1 shared OAuth cache first
  const cached = await env.DB.prepare(
    `SELECT access_token, expires_at FROM oauth_tokens WHERE provider = 'google_oauth'`
  ).first<{ access_token: string; expires_at: number }>();

  if (cached && cached.expires_at > Date.now() + 60_000) {
    return cached.access_token;
  }

  const tokenData = await withRetry(
    async () => {
      const params = new URLSearchParams({
        client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
        refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN!,
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

  const expiresAt = Date.now() + (tokenData.expires_in || 3600) * 1000;
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (provider, access_token, expires_at, updated_at)
     VALUES ('google_oauth', ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`
  )
    .bind(tokenData.access_token, expiresAt, new Date().toISOString())
    .run();

  return tokenData.access_token;
}
