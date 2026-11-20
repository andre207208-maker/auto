import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  deleteBloggerPost,
  getBlogDetails,
  listBlogPosts,
  listUserBlogs,
  publishBloggerPost,
  updateBloggerPost,
} from '../services/bloggerService.js';

const router = Router();
router.use(requireAuth);

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

router.get(
  '/blogs',
  asyncHandler(async (_req, res) => {
    const data = await listUserBlogs();
    res.json(data);
  })
);

router.get(
  '/blogs/:blogId',
  asyncHandler(async (req, res) => {
    const data = await getBlogDetails(req.params.blogId);
    res.json(data);
  })
);

router.get(
  '/posts',
  asyncHandler(async (req, res) => {
    const data = await listBlogPosts({
      blogId: typeof req.query.blogId === 'string' ? req.query.blogId : undefined,
      maxResults: req.query.maxResults ? Number(req.query.maxResults) : 20,
      status:
        req.query.status === 'draft' || req.query.status === 'scheduled'
          ? req.query.status
          : 'live',
      pageToken: typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined,
    });
    res.json(data);
  })
);

router.post(
  '/posts',
  asyncHandler(async (req, res) => {
    const input = createPostSchema.parse(req.body);
    const post = await publishBloggerPost(input);
    res.status(201).json({ post });
  })
);

router.patch(
  '/posts/:postId',
  asyncHandler(async (req, res) => {
    const input = updatePostSchema.parse(req.body);
    const post = await updateBloggerPost({
      ...input,
      postId: req.params.postId,
    });
    res.json({ post });
  })
);

router.delete(
  '/posts/:postId',
  asyncHandler(async (req, res) => {
    const blogId = typeof req.query.blogId === 'string' ? req.query.blogId : undefined;
    await deleteBloggerPost(blogId, req.params.postId);
    res.status(204).send();
  })
);

export default router;
