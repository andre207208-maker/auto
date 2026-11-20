import { WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';

export async function uploadMediaToR2(
  env: WorkerEnv,
  params: {
    key: string;
    body: ArrayBuffer | string;
    contentType?: string;
    metadata?: Record<string, string>;
  }
): Promise<{ key: string; size: number; etag: string }> {
  if (!env.MEDIA_BUCKET) {
    throw new AppError(
      'MEDIA_BUCKET R2 binding is not configured in wrangler.jsonc',
      503,
      'R2_NOT_CONFIGURED'
    );
  }

  const obj = await env.MEDIA_BUCKET.put(params.key, params.body, {
    httpMetadata: {
      contentType: params.contentType || 'application/octet-stream',
    },
    customMetadata: params.metadata,
  });

  if (!obj) {
    throw new AppError('Failed to write object to R2', 500, 'R2_PUT_FAILED');
  }

  return {
    key: obj.key,
    size: obj.size,
    etag: obj.httpEtag,
  };
}

export async function getMediaFromR2(
  env: WorkerEnv,
  key: string
): Promise<R2ObjectBody | null> {
  if (!env.MEDIA_BUCKET) {
    throw new AppError('MEDIA_BUCKET R2 binding is not configured', 503, 'R2_NOT_CONFIGURED');
  }
  return env.MEDIA_BUCKET.get(key);
}

export async function deleteMediaFromR2(env: WorkerEnv, key: string): Promise<void> {
  if (!env.MEDIA_BUCKET) {
    throw new AppError('MEDIA_BUCKET R2 binding is not configured', 503, 'R2_NOT_CONFIGURED');
  }
  await env.MEDIA_BUCKET.delete(key);
}
