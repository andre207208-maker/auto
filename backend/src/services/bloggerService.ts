import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { isTransientHttpStatus, withRetry } from '../utils/retry.js';
import { getGoogleOAuthAccessToken } from './googleAuthService.js';

const BLOGGER_API_BASE = 'https://www.googleapis.com/blogger/v3';

async function bloggerRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const accessToken = await getGoogleOAuthAccessToken();

  return withRetry(
    async () => {
      const response = await fetch(`${BLOGGER_API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        const err = new AppError(
          `Blogger API error (${response.status}): ${errorText}`,
          response.status >= 500 ? 502 : response.status,
          'BLOGGER_API_ERROR'
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
      operationName: 'blogger_api_call',
      maxAttempts: 3,
      shouldRetry: (err) => !(err as { nonRetryable?: boolean })?.nonRetryable,
    }
  );
}

export function resolveBlogId(blogId?: string): string {
  const resolved = blogId || env.DEFAULT_BLOGGER_BLOG_ID;
  if (!resolved) {
    throw new AppError(
      'Blogger blogId is required (pass blogId in request or configure DEFAULT_BLOGGER_BLOG_ID).',
      400,
      'BLOGGER_BLOG_ID_MISSING'
    );
  }
  return resolved;
}

export async function listUserBlogs(): Promise<unknown> {
  return bloggerRequest('/users/self/blogs');
}

export async function getBlogDetails(blogId?: string): Promise<unknown> {
  const id = resolveBlogId(blogId);
  return bloggerRequest(`/blogs/${encodeURIComponent(id)}`);
}

export async function listBlogPosts(params: {
  blogId?: string;
  maxResults?: number;
  status?: 'live' | 'draft' | 'scheduled';
  pageToken?: string;
}): Promise<unknown> {
  const id = resolveBlogId(params.blogId);
  const query = new URLSearchParams({
    maxResults: String(params.maxResults || 20),
    status: params.status || 'live',
  });
  if (params.pageToken) {
    query.set('pageToken', params.pageToken);
  }
  return bloggerRequest(`/blogs/${encodeURIComponent(id)}/posts?${query.toString()}`);
}

export interface BloggerPostPayload {
  blogId?: string;
  title: string;
  content: string;
  labels?: string[];
  isDraft?: boolean;
}

export interface BloggerPostResponse {
  id: string;
  url: string;
  title: string;
  published?: string;
  updated?: string;
  status?: string;
  labels?: string[];
}

export async function publishBloggerPost(payload: BloggerPostPayload): Promise<BloggerPostResponse> {
  const id = resolveBlogId(payload.blogId);
  const query = payload.isDraft ? '?isDraft=true' : '';
  return bloggerRequest<BloggerPostResponse>(`/blogs/${encodeURIComponent(id)}/posts${query}`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'blogger#post',
      blog: { id },
      title: payload.title,
      content: payload.content,
      labels: payload.labels || [],
    }),
  });
}

export async function updateBloggerPost(params: {
  blogId?: string;
  postId: string;
  title?: string;
  content?: string;
  labels?: string[];
}): Promise<BloggerPostResponse> {
  const id = resolveBlogId(params.blogId);
  return bloggerRequest<BloggerPostResponse>(
    `/blogs/${encodeURIComponent(id)}/posts/${encodeURIComponent(params.postId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        ...(params.title ? { title: params.title } : {}),
        ...(params.content ? { content: params.content } : {}),
        ...(params.labels ? { labels: params.labels } : {}),
      }),
    }
  );
}

export async function deleteBloggerPost(blogId: string | undefined, postId: string): Promise<void> {
  const id = resolveBlogId(blogId);
  await bloggerRequest(`/blogs/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}`, {
    method: 'DELETE',
  });
}
