import { describe, expect, it, vi, beforeEach } from 'vitest';
import workerEntry from '../src/index.js';
import { QueueTaskMessage, WorkerEnv } from '../src/types/index.js';

/**
 * Lightweight in-memory D1 mock supporting prepared statements and state transitions
 * needed to test Worker HTTP routes, Queues, Cron handlers, and AI failover locally.
 */
function createMockD1(): D1Database {
  const agentState: {
    id: string;
    status: string;
    emergency_stop: number;
    reason: string | null;
    updated_by: string | null;
    updated_at: string;
  } = {
    id: 'agent',
    status: 'running',
    emergency_stop: 0,
    reason: 'Initial boot',
    updated_by: 'system',
    updated_at: new Date().toISOString(),
  };

  const tasks = new Map<string, Record<string, unknown>>();
  const providerHealth = new Map<string, Record<string, unknown>>();
  const campaigns = new Map<string, Record<string, unknown>>();
  const oauthTokens = new Map<string, Record<string, unknown>>();
  const systemLogs: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];

  const makeStmt = (sql: string, args: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    const execFirst = async <T>(): Promise<T | null> => {
      if (normalized.startsWith('SELECT 1 AS ok')) {
        return { ok: 1 } as T;
      }
      if (normalized.includes('FROM agent_state WHERE id =')) {
        return { ...agentState } as T;
      }
      if (normalized.includes('FROM task_queue WHERE idempotency_key =')) {
        const key = args[0] as string;
        for (const t of tasks.values()) {
          if (t.idempotency_key === key) {
            return { ...t } as T;
          }
        }
        return null;
      }
      if (normalized.includes('FROM task_queue WHERE id =')) {
        const row = tasks.get(args[0] as string);
        return row ? ({ ...row } as T) : null;
      }
      if (normalized.includes('FROM oauth_tokens WHERE provider =')) {
        const row = oauthTokens.get(args[0] as string);
        return row ? ({ ...row } as T) : null;
      }
      return null;
    };

    const execAll = async <T>(): Promise<D1Result<T>> => {
      let results: unknown[] = [];
      if (normalized.includes('FROM ai_provider_health')) {
        results = Array.from(providerHealth.values());
      } else if (normalized.includes('FROM task_queue')) {
        results = Array.from(tasks.values());
      } else if (normalized.includes('FROM campaigns')) {
        results = Array.from(campaigns.values());
      } else if (normalized.includes('FROM system_logs')) {
        results = [...systemLogs];
      } else if (normalized.includes('FROM device_tokens')) {
        results = [];
      } else if (normalized.includes('FROM notifications')) {
        results = [...notifications];
      }
      return {
        results: results as T[],
        success: true,
        meta: { duration: 1, changes: 0, last_row_id: 0, changed_db: false, size_after: 0, rows_read: results.length, rows_written: 0 },
      };
    };

    const execRun = async (): Promise<D1Result> => {
      let changes = 0;

      if (normalized.startsWith('INSERT INTO agent_state')) {
        agentState.status = args[0] as string;
        agentState.emergency_stop = args[1] as number;
        agentState.reason = (args[2] as string | null) ?? null;
        agentState.updated_by = (args[3] as string | null) ?? null;
        agentState.updated_at = args[4] as string;
        changes = 1;
      } else if (normalized.startsWith('INSERT INTO ai_provider_health')) {
        providerHealth.set(args[0] as string, {
          provider: args[0],
          configured: args[1],
          healthy: args[2],
          consecutive_failures: args[3],
          circuit_open_until: args[4],
          last_error: args[5],
          last_success_at: args[6],
          last_failure_at: args[7],
          average_latency_ms: args[8],
          updated_at: args[9],
        });
        changes = 1;
      } else if (normalized.startsWith('INSERT INTO task_queue')) {
        tasks.set(args[0] as string, {
          id: args[0],
          idempotency_key: args[1],
          type: args[2],
          payload_json: args[3],
          status: args[4],
          attempts: args[5],
          max_attempts: args[6],
          next_retry_at: args[7],
          last_error: args[8],
          result_json: args[9],
          created_by: args[10],
          created_at: args[11],
          updated_at: args[12],
          completed_at: args[13],
        });
        changes = 1;
      } else if (normalized.startsWith("UPDATE task_queue SET status = 'processing'")) {
        const updatedAt = args[0] as string;
        const id = args[1] as string;
        const row = tasks.get(id);
        if (row && (row.status === 'queued' || row.status === 'retrying')) {
          row.status = 'processing';
          row.attempts = Number(row.attempts) + 1;
          row.updated_at = updatedAt;
          changes = 1;
        }
      } else if (normalized.startsWith("UPDATE task_queue SET status = 'completed'")) {
        const row = tasks.get(args[3] as string);
        if (row) {
          row.status = 'completed';
          row.result_json = args[0];
          row.last_error = null;
          row.next_retry_at = null;
          row.completed_at = args[1];
          row.updated_at = args[2];
          changes = 1;
        }
      } else if (normalized.startsWith("UPDATE task_queue SET status = 'cancelled'")) {
        for (const row of tasks.values()) {
          if (row.status === 'queued' || row.status === 'retrying') {
            row.status = 'cancelled';
            row.last_error = args[0];
            row.updated_at = args[1];
            changes += 1;
          }
        }
      } else if (normalized.startsWith('INSERT INTO oauth_tokens')) {
        oauthTokens.set('google_oauth', {
          provider: 'google_oauth',
          access_token: args[0],
          expires_at: args[1],
          updated_at: args[2],
        });
        changes = 1;
      } else if (normalized.startsWith('INSERT INTO system_logs')) {
        systemLogs.push({ id: args[0], level: args[1], category: args[2], message: args[3] });
        changes = 1;
      } else if (normalized.startsWith('INSERT INTO notifications')) {
        notifications.push({ id: args[0], title: args[1], body: args[2] });
        changes = 1;
      }

      return {
        results: [],
        success: true,
        meta: { duration: 1, changes, last_row_id: 0, changed_db: changes > 0, size_after: 0, rows_read: 0, rows_written: changes },
      };
    };

    return {
      bind: (...boundArgs: unknown[]) => makeStmt(sql, boundArgs),
      first: execFirst,
      all: execAll,
      run: execRun,
      raw: async () => [],
    } as unknown as D1PreparedStatement;
  };

  return {
    prepare: (sql: string) => makeStmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    withSession: () => {
      throw new Error('Not implemented in mock');
    },
  } as unknown as D1Database;
}

function createTestEnv(overrides: Partial<WorkerEnv> = {}): {
  env: WorkerEnv;
  sentQueueMessages: QueueTaskMessage[];
} {
  const sentQueueMessages: QueueTaskMessage[] = [];
  const env: WorkerEnv = {
    DB: createMockD1(),
    TASK_QUEUE: {
      send: async (msg: QueueTaskMessage) => {
        sentQueueMessages.push(msg);
      },
      sendBatch: async () => {},
    } as unknown as Queue<QueueTaskMessage>,
    SERVICE_NAME: 'autoblogger-ai-backend',
    ENVIRONMENT: 'test',
    ALLOW_API_KEY_AUTH: 'true',
    BACKEND_API_SECRET: 'test-super-secret-api-key-123456',
    SCHEDULER_SHARED_SECRET: 'test-scheduler-secret-123456',
    AI_PROVIDER_ORDER: 'gemini,openrouter,apinex,custom',
    GEMINI_API_KEY: 'test-gemini-key',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh-token',
    DEFAULT_BLOGGER_BLOG_ID: '1234567890',
    ...overrides,
  };
  return { env, sentQueueMessages };
}

const pendingWaitUntil: Promise<unknown>[] = [];
const dummyCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    pendingWaitUntil.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe('AUTOBLOGGER AI Cloudflare Worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pendingWaitUntil.length = 0;
  });

  it('GET /health returns 200 OK with valid Android verification payload', async () => {
    const { env } = createTestEnv();
    const res = await workerEntry.fetch(new Request('https://worker.example/health'), env, dummyCtx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('autoblogger-ai-backend');
    expect(body.runtime).toBe('cloudflare-workers');
    expect(body.dbConnected).toBe(true);
    expect(body.queueConfigured).toBe(true);
    expect(body.agentStatus).toBe('running');
  });

  it('rejects unauthenticated /api/v1 requests and accepts valid X-API-Key', async () => {
    const { env } = createTestEnv();
    const unauth = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/agent/status'),
      env,
      dummyCtx
    );
    expect(unauth.status).toBe(401);

    const authed = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/agent/status', {
        headers: { 'X-API-Key': 'test-super-secret-api-key-123456' },
      }),
      env,
      dummyCtx
    );
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { agent: { status: string } };
    expect(body.agent.status).toBe('running');
  });

  it('supports pause, resume, and emergency stop cancelling pending tasks', async () => {
    const { env } = createTestEnv();

    // Enqueue a task first
    const enqueueRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/tasks/enqueue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({
          type: 'RESEARCH_TOPIC',
          payload: { niche: 'Cloudflare Workers' },
          idempotencyKey: 'idem-1',
        }),
      }),
      env,
      dummyCtx
    );
    expect(enqueueRes.status).toBe(202);

    // Duplicate idempotency key should deduplicate
    const dupRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/tasks/enqueue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({
          type: 'RESEARCH_TOPIC',
          payload: { niche: 'Cloudflare Workers' },
          idempotencyKey: 'idem-1',
        }),
      }),
      env,
      dummyCtx
    );
    expect(dupRes.status).toBe(200);
    const dupBody = (await dupRes.json()) as { duplicate: boolean };
    expect(dupBody.duplicate).toBe(true);

    // Trigger emergency stop
    const stopRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/agent/emergency-stop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({ reason: 'Unit test halt' }),
      }),
      env,
      dummyCtx
    );
    expect(stopRes.status).toBe(200);
    const stopBody = (await stopRes.json()) as {
      agent: { status: string; emergencyStop: boolean };
      cancelledTasks: number;
    };
    expect(stopBody.agent.status).toBe('stopped');
    expect(stopBody.agent.emergencyStop).toBe(true);
    expect(stopBody.cancelledTasks).toBe(1);
  });

  it('automatically fails over from Gemini to OpenRouter on upstream failure', async () => {
    const { env } = createTestEnv();

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Gemini rate limit', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Fallback response from OpenRouter' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const res = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/ai/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({ prompt: 'Hello AI' }),
      }),
      env,
      dummyCtx
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      provider: string;
      text: string;
      attempts: Array<{ provider: string; success: boolean }>;
    };
    expect(data.provider).toBe('openrouter');
    expect(data.text).toBe('Fallback response from OpenRouter');
    expect(data.attempts).toHaveLength(2);
    expect(data.attempts[0]).toMatchObject({ provider: 'gemini', success: false });
    expect(data.attempts[1]).toMatchObject({ provider: 'openrouter', success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('processes Cloudflare Queue batch messages and Cron Triggers', async () => {
    const { env, sentQueueMessages } = createTestEnv();

    // Daily cron trigger should enqueue SYNC_ANALYTICS_DAILY
    await workerEntry.scheduled(
      { cron: '50 23 * * *', scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      env,
      dummyCtx
    );
    await Promise.all(pendingWaitUntil);

    expect(sentQueueMessages).toHaveLength(1);
    expect(sentQueueMessages[0].type).toBe('SYNC_ANALYTICS_DAILY');

    // Enqueue a SEND_NOTIFICATION task and process via queue consumer
    const enq = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/tasks/enqueue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({
          type: 'SEND_NOTIFICATION',
          payload: { title: 'Test', body: 'Queue works' },
        }),
      }),
      env,
      dummyCtx
    );
    const enqJson = (await enq.json()) as { task: { id: string } };

    let acked = false;
    await workerEntry.queue(
      {
        queue: 'autoblogger-tasks',
        ackAll: () => {},
        retryAll: () => {},
        messages: [
          {
            id: 'msg-1',
            timestamp: new Date(),
            attempts: 1,
            body: {
              taskId: enqJson.task.id,
              type: 'SEND_NOTIFICATION',
              enqueuedAt: new Date().toISOString(),
            },
            ack: () => {
              acked = true;
            },
            retry: () => {},
          },
        ],
      } as unknown as MessageBatch<QueueTaskMessage>,
      env,
      dummyCtx
    );

    expect(acked).toBe(true);
  });

  it('executes Blogger OAuth token refresh and post publishing contract', async () => {
    const { env } = createTestEnv();

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'post-99',
            url: 'https://example.blogspot.com/2026/11/test.html',
            title: 'Test Post',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const res = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/blogger/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({
          title: 'Test Post',
          content: '<p>Hello Blogger</p>',
          labels: ['Tech'],
        }),
      }),
      env,
      dummyCtx
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { post: { id: string; url: string } };
    expect(body.post.id).toBe('post-99');
    expect(body.post.url).toContain('blogspot.com');
  });

  it('audits SEO and runs Tavily-grounded research endpoint', async () => {
    const { env } = createTestEnv({ TAVILY_API_KEY: 'test-tavily-key' });

    const seoRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/seo/audit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({
          title: 'Cloudflare Workers Guide for Beginners',
          metaDescription:
            'Learn how to build serverless APIs with Cloudflare Workers, D1 database, and Queues in this complete step-by-step developer guide.',
          htmlContent:
            '<p>Cloudflare Workers lets you deploy serverless functions globally.</p><h2>Why Cloudflare Workers</h2><p>Fast edge execution with Cloudflare Workers.</p>',
          primaryKeyword: 'Cloudflare Workers',
        }),
      }),
      env,
      dummyCtx
    );
    expect(seoRes.status).toBe(200);
    const seoBody = (await seoRes.json()) as { audit: { score: number; h2Count: number } };
    expect(seoBody.audit.h2Count).toBe(1);
    expect(seoBody.audit.score).toBeGreaterThan(50);

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ title: 'CF Docs', url: 'https://developers.cloudflare.com', content: 'Workers overview' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        niche: 'Serverless',
                        primaryKeyword: 'Cloudflare Workers',
                        secondaryKeywords: ['D1', 'Queues'],
                        searchIntent: 'informational',
                        suggestedTitles: ['Cloudflare Workers Complete Guide'],
                        outline: [{ heading: 'Intro', subheadings: ['Overview'], keyPoints: ['Edge'] }],
                        faqQuestions: ['Is Cloudflare Workers free?'],
                        estimatedDifficulty: 'medium',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        )
      );

    const res = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/content/research', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({ niche: 'Serverless', seedKeyword: 'Cloudflare Workers' }),
      }),
      env,
      dummyCtx
    );
    expect(res.status).toBe(200);
    const researchBody = (await res.json()) as {
      research: { primaryKeyword: string; tavilySources: Array<{ title: string }> };
    };
    expect(researchBody.research.primaryKeyword).toBe('Cloudflare Workers');
    expect(researchBody.research.tavilySources[0].title).toBe('CF Docs');
  });
});
