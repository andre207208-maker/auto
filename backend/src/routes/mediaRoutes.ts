import { Hono } from 'hono';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import { deleteMediaFromR2, getMediaFromR2, uploadMediaToR2 } from '../services/r2MediaService.js';
import { WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';

const mediaRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
mediaRoutes.use('*', requireAuth);

mediaRoutes.post('/upload', async (c) => {
  const key = c.req.header('x-media-key') || `uploads/${Date.now()}-${crypto.randomUUID()}`;
  const contentType = c.req.header('content-type') || 'application/octet-stream';
  const body = await c.req.arrayBuffer();

  if (body.byteLength === 0) {
    throw new AppError('Empty upload body', 400, 'EMPTY_BODY');
  }

  const uploaded = await uploadMediaToR2(c.env, {
    key,
    body,
    contentType,
  });

  return c.json({ uploaded }, 201);
});

mediaRoutes.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const object = await getMediaFromR2(c.env, key);
  if (!object) {
    throw new AppError('Media asset not found', 404, 'MEDIA_NOT_FOUND');
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  const bodyCopy = new Uint8Array(object.body.byteLength);
  bodyCopy.set(object.body);
  return new Response(bodyCopy.buffer, { headers });
});

mediaRoutes.delete('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  await deleteMediaFromR2(c.env, key);
  return c.body(null, 204);
});

export default mediaRoutes;
