import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import {
  deleteBloggerPost,
  getBlogDetails,
  listBlogPosts,
  listUserBlogs,
  publishBloggerPost,
  updateBloggerPost,
} from '../services/bloggerService.js';
import { WorkerEnv } from '../types/index.js';

const bloggerRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
bloggerRoutes.use('*', requireAuth);

const createPostSchema = z.object({
  blogId: z.string().optional(),
  title: z.string().min(1).max(300),
  content: z.string().min(1),
  labels: z.array(z.string().max(100)).max(20).optional(),
  isDraft: z.boolean().optional(),
});

const updatePostSchema = z.object({
  blogId: z.string().optional(),
  title: z.string().min(1).max(300).optional(),
  content: z.string().min(1).optional(),
  labels: z.array(z.string().max(100)).max(20).optional(),
});

bloggerRoutes.get('/blogs', async (c) => {
  const data = await listUserBlogs(c.env);
  return c.json(data as Record<string, unknown>);
});

bloggerRoutes.get('/blogs/:blogId', async (c) => {
  const data = await getBlogDetails(c.env, c.req.param('blogId'));
  return c.json(data as Record<string, unknown>);
});

bloggerRoutes.get('/posts', async (c) => {
  const statusQuery = c.req.query('status');
  const maxResultsQuery = c.req.query('maxResults');
  const data = await listBlogPosts(c.env, {
    blogId: c.req.query('blogId'),
    maxResults: maxResultsQuery ? Number(maxResultsQuery) : 20,
    status: statusQuery === 'draft' || statusQuery === 'scheduled' ? statusQuery : 'live',
    pageToken: c.req.query('pageToken'),
  });
  return c.json(data as Record<string, unknown>);
});

bloggerRoutes.post('/posts', async (c) => {
  const input = createPostSchema.parse(await c.req.json());
  const post = await publishBloggerPost(c.env, input);
  return c.json({ post }, 201);
});

bloggerRoutes.patch('/posts/:postId', async (c) => {
  const input = updatePostSchema.parse(await c.req.json());
  const post = await updateBloggerPost(c.env, {
    ...input,
    postId: c.req.param('postId'),
  });
  return c.json({ post });
});

bloggerRoutes.delete('/posts/:postId', async (c) => {
  await deleteBloggerPost(c.env, c.req.query('blogId'), c.req.param('postId'));
  return c.body(null, 204);
});

export default bloggerRoutes;
