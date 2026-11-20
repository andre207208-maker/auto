import {
  deleteMediaAssetRow,
  getMediaAssetRow,
  upsertMediaAssetRow,
} from '../db/repositories.js';
import { WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';

const MAX_D1_MEDIA_BYTES = 750 * 1024; // Keep safely under Cloudflare D1 1MB row limit

function toUint8Array(body: ArrayBuffer | string): Uint8Array {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  }
  return new Uint8Array(body);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hashBuffer = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export interface StoredMediaObject {
  key: string;
  contentType: string;
  size: number;
  httpEtag: string;
  body: Uint8Array;
  writeHttpMetadata(headers: Headers): void;
}

export async function uploadMediaAsset(
  env: WorkerEnv,
  params: {
    key: string;
    body: ArrayBuffer | string;
    contentType?: string;
    metadata?: Record<string, string>;
  }
): Promise<{ key: string; size: number; etag: string; storage: 'd1' }> {
  const bytes = toUint8Array(params.body);
  if (bytes.byteLength > MAX_D1_MEDIA_BYTES) {
    throw new AppError(
      `Media asset exceeds Free-plan D1 storage limit (${MAX_D1_MEDIA_BYTES} bytes). Store large media externally or compress the asset.`,
      413,
      'MEDIA_TOO_LARGE'
    );
  }

  const contentType = params.contentType || 'application/octet-stream';
  const etag = `"${await computeSha256Hex(bytes)}"`;
  const dataBase64 = encodeBase64(bytes);

  await upsertMediaAssetRow(env.DB, {
    key: params.key,
    contentType,
    sizeBytes: bytes.byteLength,
    etag,
    dataBase64,
    metadata: params.metadata,
  });

  return {
    key: params.key,
    size: bytes.byteLength,
    etag,
    storage: 'd1',
  };
}

export async function getMediaAsset(
  env: WorkerEnv,
  key: string
): Promise<StoredMediaObject | null> {
  const row = await getMediaAssetRow(env.DB, key);
  if (!row) {
    return null;
  }

  const bytes = decodeBase64(row.dataBase64);
  return {
    key: row.key,
    contentType: row.contentType,
    size: row.sizeBytes,
    httpEtag: row.etag,
    body: bytes,
    writeHttpMetadata(headers: Headers) {
      headers.set('Content-Type', row.contentType);
      headers.set('Content-Length', String(bytes.byteLength));
    },
  };
}

export async function deleteMediaAsset(env: WorkerEnv, key: string): Promise<void> {
  await deleteMediaAssetRow(env.DB, key);
}

// Backward-compatible exports for existing route & worker imports
export const uploadMediaToR2 = uploadMediaAsset;
export const getMediaFromR2 = getMediaAsset;
export const deleteMediaFromR2 = deleteMediaAsset;
