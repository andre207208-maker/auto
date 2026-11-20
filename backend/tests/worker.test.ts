import { beforeEach, describe, expect, it, vi } from 'vitest';
import workerEntry from '../src/index.js';
import { WorkerEnv } from '../src/types/index.js';

/**
 * In-memory D1 mock supporting all 15 tables & prepared statements
 * needed to test Worker HTTP routes, D1 persistent job queue + locking, Cron Triggers,
 * multi-key AI failover, SEO quality gates, Adsterra injection, D1 media storage, and analytics locally.
 */
function createMockD1(): { db: D1Database; tasks: Map<string, Record<string, unknown>> } {
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
  const pipelines = new Map<string, Record<string, unknown>>();
  const posts = new Map<string, Record<string, unknown>>();
  const providerHealth = new Map<string, Record<string, unknown>>();
  const campaigns = new Map<string, Record<string, unknown>>();
  const adConfigs = new Map<string, Record<string, unknown>>();
  const appSettings = new Map<string, Record<string, unknown>>();
  const rateLimits = new Map<string, { request_count: number; reset_at: number }>();
  const oauthTokens = new Map<string, Record<string, unknown>>();
  const analyticsSnapshots = new Map<string, Record<string, unknown>>();
  const mediaAssets = new Map<string, Record<string, unknown>>();
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
      if (normalized.includes('FROM app_settings WHERE key =')) {
        const row = appSettings.get(args[0] as string);
        return row ? ({ ...row } as T) : null;
      }
      if (normalized.includes('FROM rate_limits WHERE bucket_key =')) {
        const row = rateLimits.get(args[0] as string);
        return row ? ({ ...row } as T) : null;
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
      if (normalized.includes('FROM pipeline_runs WHERE id =')) {
        const row = pipelines.get(args[0] as string);
        return row ? ({ ...row } as T) : null;
      }
      if (normalized.includes('FROM posts WHERE content_hash =')) {
        for (const p of posts.values()) {
          if (p.content_hash === args[0]) {
            return { ...p } as T;
          }
        }
        return null;
      }
      if (normalized.includes('FROM posts WHERE slug = ? AND blog_id =')) {
        for (const p of posts.values()) {
          if (p.slug === args[0] && p.blog_id === args[1]) {
            return { ...p } as T;
          }
        }
        return null;
      }
      if (normalized.includes('SELECT COUNT(*) AS cnt FROM posts')) {
        return { cnt: posts.size } as T;
      }
      if (normalized.includes('FROM oauth_tokens WHERE provider =')) {
        const row = oauthTokens.get(args[0] as string);
        return row ? ({ ...row } as T) : null;
      }
      if (normalized.includes('FROM media_assets WHERE key =')) {
        const row = mediaAssets.get(args[0] as string);
        return row ? ({ ...row } as T) : null;
      }
      return null;
    };

    const execAll = async <T>(): Promise<D1Result<T>> => {
      let results: unknown[] = [];
      if (normalized.includes('SELECT status, COUNT(*) AS cnt FROM task_queue GROUP BY status')) {
        const grouped = new Map<string, number>();
        for (const t of tasks.values()) {
          const st = String(t.status);
          grouped.set(st, (grouped.get(st) ?? 0) + 1);
        }
        results = Array.from(grouped.entries()).map(([status, cnt]) => ({ status, cnt }));
      } else if (
        normalized.includes(
          "FROM task_queue WHERE status IN ('queued', 'retrying') AND (next_retry_at IS NULL OR next_retry_at <= ?)"
        )
      ) {
        const nowIso = args[0] as string;
        const limit = Number(args[1] ?? 3);
        results = Array.from(tasks.values())
          .filter(
            (t) =>
              (t.status === 'queued' || t.status === 'retrying') &&
              (t.next_retry_at === null || String(t.next_retry_at) <= nowIso)
          )
          .sort(
            (a, b) =>
              Number(a.priority ?? 5) - Number(b.priority ?? 5) ||
              String(a.created_at).localeCompare(String(b.created_at))
          )
          .slice(0, limit);
      } else if (normalized.includes("FROM task_queue WHERE status IN ('queued', 'retrying')")) {
        const limit = Number(args[0] ?? 50);
        results = Array.from(tasks.values())
          .filter((t) => t.status === 'queued' || t.status === 'retrying')
          .slice(0, limit);
      } else if (normalized.includes('FROM task_queue WHERE status =')) {
        const st = args[0] as string;
        const limit = Number(args[1] ?? 50);
        results = Array.from(tasks.values())
          .filter((t) => t.status === st)
          .slice(0, limit);
      } else if (normalized.includes('FROM task_queue')) {
        results = Array.from(tasks.values());
      } else if (normalized.includes('FROM ai_provider_health')) {
        results = Array.from(providerHealth.values());
      } else if (normalized.includes('FROM campaigns')) {
        results = Array.from(campaigns.values());
      } else if (normalized.includes('FROM ad_configs')) {
        results = Array.from(adConfigs.values());
      } else if (normalized.includes('FROM posts')) {
        results = Array.from(posts.values());
      } else if (normalized.includes('FROM analytics_snapshots')) {
        results = Array.from(analyticsSnapshots.values());
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
        meta: {
          duration: 1,
          changes: 0,
          last_row_id: 0,
          changed_db: false,
          size_after: 0,
          rows_read: results.length,
          rows_written: 0,
        },
      };
    };

    const execRun = async (): Promise<D1Result> => {
      let changes = 0;

      if (normalized.startsWith('INSERT INTO app_settings')) {
        appSettings.set(args[0] as string, {
          key: args[0],
          value_json: args[1],
          updated_by: args[2],
          updated_at: args[3],
        });
        changes = 1;
      } else if (normalized.startsWith('INSERT INTO rate_limits')) {
        rateLimits.set(args[0] as string, {
          request_count: 1,
          reset_at: args[1] as number,
        });
        changes = 1;
      } else if (normalized.startsWith('UPDATE rate_limits SET request_count =')) {
        const bucket = rateLimits.get(args[1] as string);
        if (bucket) {
          bucket.request_count = args[0] as number;
          changes = 1;
        }
      } else if (normalized.startsWith('INSERT INTO agent_state')) {
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
          total_requests: args[5],
          total_errors: args[6],
          rate_limit_hits: args[7],
          last_model_used: args[8],
          last_error: args[9],
          last_success_at: args[10],
          last_failure_at: args[11],
          average_latency_ms: args[12],
          updated_at: args[13],
        });
        changes = 1;
      } else if (normalized.startsWith('INSERT INTO task_queue')) {
        tasks.set(args[0] as string, {
          id: args[0],
          idempotency_key: args[1],
          type: args[2],
          payload_json: args[3],
          status: args[4],
          priority: args[5],
          attempts: args[6],
          max_attempts: args[7],
          next_retry_at: args[8],
          last_error: args[9],
          result_json: args[10],
          created_by: args[11],
          created_at: args[12],
          updated_at: args[13],
          completed_at: args[14],
          locked_at: null,
          locked_by: null,
          lock_expires_at: null,
          started_at: null,
        });
        changes = 1;
      } else if (normalized.startsWith("UPDATE task_queue SET status = 'processing'")) {
        const now = args[0] as string;
        const workerId = args[1] as string;
        const lockExpiresAt = args[2] as string;
        const startedAt = args[3] as string;
        const updatedAt = args[4] as string;
        const id = args[5] as string;
        const row = tasks.get(id);
        if (row && (row.status === 'queued' || row.status === 'retrying')) {
          row.status = 'processing';
          row.attempts = Number(row.attempts) + 1;
          row.locked_at = now;
          row.locked_by = workerId;
          row.lock_expires_at = lockExpiresAt;
          row.started_at = row.started_at ?? startedAt;
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
          row.locked_at = null;
          row.locked_by = null;
          row.lock_expires_at = null;
          row.completed_at = args[1];
          row.updated_at = args[2];
          changes = 1;
        }
      } else if (
        normalized.includes("SET status = 'dead_letter'") &&
        normalized.includes('AND lock_expires_at <= ?')
      ) {
        const nowIso = args[0] as string;
        for (const row of tasks.values()) {
          if (
            row.status === 'processing' &&
            row.lock_expires_at !== null &&
            String(row.lock_expires_at) <= nowIso &&
            Number(row.attempts) >= Number(row.max_attempts)
          ) {
            row.status = 'dead_letter';
            row.last_error = row.last_error || 'Worker execution lock expired after max attempts';
            row.locked_at = null;
            row.locked_by = null;
            row.lock_expires_at = null;
            row.next_retry_at = null;
            row.updated_at = nowIso;
            changes += 1;
          }
        }
      } else if (
        normalized.includes("SET status = 'retrying'") &&
        normalized.includes('AND lock_expires_at <= ?')
      ) {
        const nowIso = args[0] as string;
        for (const row of tasks.values()) {
          if (
            row.status === 'processing' &&
            row.lock_expires_at !== null &&
            String(row.lock_expires_at) <= nowIso &&
            Number(row.attempts) < Number(row.max_attempts)
          ) {
            row.status = 'retrying';
            row.last_error = 'Recovered expired D1 worker lock; scheduled for retry';
            row.locked_at = null;
            row.locked_by = null;
            row.lock_expires_at = null;
            row.next_retry_at = nowIso;
            row.updated_at = nowIso;
            changes += 1;
          }
        }
      } else if (
        normalized.startsWith("UPDATE task_queue SET status = 'dead_letter'") &&
        normalized.includes('WHERE id = ?')
      ) {
        const row = tasks.get(args[2] as string);
        if (row) {
          row.status = 'dead_letter';
          row.last_error = args[0];
          row.next_retry_at = null;
          row.locked_at = null;
          row.locked_by = null;
          row.lock_expires_at = null;
          row.updated_at = args[1];
          changes = 1;
        }
      } else if (
        normalized.startsWith("UPDATE task_queue SET status = 'retrying'") &&
        normalized.includes('WHERE id = ?')
      ) {
        const row = tasks.get(args[3] as string);
        if (row) {
          row.status = 'retrying';
          row.last_error = args[0];
          row.next_retry_at = args[1];
          row.locked_at = null;
          row.locked_by = null;
          row.lock_expires_at = null;
          row.updated_at = args[2];
          changes = 1;
        }
      } else if (normalized.startsWith("UPDATE task_queue SET status = 'cancelled'")) {
        for (const row of tasks.values()) {
          if (row.status === 'queued' || row.status === 'retrying') {
            row.status = 'cancelled';
            row.last_error = args[0];
            row.locked_at = null;
            row.locked_by = null;
            row.lock_expires_at = null;
            row.updated_at = args[1];
            changes += 1;
          }
        }
      } else if (normalized.startsWith('INSERT INTO pipeline_runs')) {
        pipelines.set(args[0] as string, {
          id: args[0],
          campaign_id: args[1],
          stage: args[2],
          niche: args[3],
          seed_keyword: args[4],
          blog_id: args[5],
          language: args[6],
          tone: args[7],
          publish_as_draft: args[8],
          inject_ads: args[9],
          preferred_provider: args[10],
          triggered_by: args[11],
          created_at: args[12],
          updated_at: args[13],
          research_json: null,
          article_json: null,
          seo_json: null,
          result_json: null,
          error_message: null,
          completed_at: null,
        });
        changes = 1;
      } else if (normalized.startsWith('UPDATE pipeline_runs')) {
        const row = pipelines.get(args[8] as string);
        if (row) {
          row.stage = args[0];
          if (args[1] !== null) row.research_json = args[1];
          if (args[2] !== null) row.article_json = args[2];
          if (args[3] !== null) row.seo_json = args[3];
          if (args[4] !== null) row.result_json = args[4];
          row.error_message = args[5];
          if (args[6] !== null) row.completed_at = args[6];
          row.updated_at = args[7];
          changes = 1;
        }
      } else if (normalized.startsWith('INSERT INTO posts')) {
        posts.set(args[0] as string, {
          id: args[0],
          pipeline_id: args[1],
          campaign_id: args[2],
          blog_id: args[3],
          blogger_post_id: args[4],
          blogger_url: args[5],
          title: args[6],
          slug: args[7],
          content_hash: args[8],
          canonical_url: args[9],
          meta_description: args[10],
          primary_keyword: args[11],
          secondary_keywords_json: args[12],
          labels_json: args[13],
          word_count: args[14],
          seo_score: args[15],
          provider_used: args[16],
          model_used: args[17],
          is_draft: args[18],
          r2_asset_key: args[19],
          last_audited_at: args[20],
          triggered_by: args[21],
          published_at: args[22],
        });
        changes = 1;
      } else if (normalized.startsWith('INSERT INTO media_assets')) {
        mediaAssets.set(args[0] as string, {
          key: args[0],
          content_type: args[1],
          size_bytes: args[2],
          etag: args[3],
          data_base64: args[4],
          metadata_json: args[5],
          created_at: args[6],
          updated_at: args[7],
        });
        changes = 1;
      } else if (normalized.startsWith('DELETE FROM media_assets')) {
        changes = mediaAssets.delete(args[0] as string) ? 1 : 0;
      } else if (normalized.startsWith('INSERT INTO ad_configs')) {
        adConfigs.set(args[0] as string, {
          id: args[0],
          name: args[1],
          placement_type: args[2],
          device_target: args[3],
          script_html: args[4],
          enabled: args[5],
          insert_after_paragraph: args[6],
          updated_at: args[7],
        });
        changes = 1;
      } else if (normalized.startsWith('DELETE FROM ad_configs')) {
        changes = adConfigs.delete(args[0] as string) ? 1 : 0;
      } else if (normalized.startsWith('INSERT INTO analytics_snapshots')) {
        analyticsSnapshots.set(args[0] as string, {
          id: args[0],
          period: args[1],
          start_date: args[2],
          end_date: args[3],
          published_posts_count: args[4],
          sources_json: args[5],
          errors_json: args[6],
          generated_at: args[7],
        });
        changes = 1;
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
        meta: {
          duration: 1,
          changes,
          last_row_id: 0,
          changed_db: changes > 0,
          size_after: 0,
          rows_read: 0,
          rows_written: changes,
        },
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

  const db = {
    prepare: (sql: string) => makeStmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    withSession: () => {
      throw new Error('Not implemented in mock');
    },
  } as unknown as D1Database;

  return { db, tasks };
}

function createTestEnv(overrides: Partial<WorkerEnv> = {}): {
  env: WorkerEnv;
  tasks: Map<string, Record<string, unknown>>;
} {
  const { db, tasks } = createMockD1();
  const env: WorkerEnv = {
    DB: db,
    SERVICE_NAME: 'autoblogger-ai',
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
  return { env, tasks };
}

const pendingWaitUntil: Promise<unknown>[] = [];
const dummyCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    pendingWaitUntil.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe('AUTOBLOGGER AI Cloudflare Free-Plan Worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pendingWaitUntil.length = 0;
  });

  it('GET /health returns 200 OK with Free-plan D1 queue/media status for Android verification', async () => {
    const { env } = createTestEnv();
    const res = await workerEntry.fetch(new Request('https://worker.example/health'), env, dummyCtx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('autoblogger-ai');
    expect(body.platform).toBe('cloudflare-workers');
    expect(body.runtime).toBe('cloudflare-workers');
    expect(body.dbConnected).toBe(true);
    expect(body.queueConfigured).toBe(true);
    expect(body.queueBackend).toBe('d1');
    expect(body.r2Configured).toBe(false);
    expect(body.mediaStorageBackend).toBe('d1');
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

  it('supports pause, resume, and emergency stop cancelling pending D1 jobs', async () => {
    const { env } = createTestEnv();

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

  it('rotates multiple API keys per provider and fails over on rate-limit / quota exhaustion', async () => {
    const { env } = createTestEnv({
      GEMINI_API_KEYS: 'gem-key-1,gem-key-2',
      GEMINI_API_KEY: undefined,
    });

    const priorityRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/ai/providers/priority', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({ order: ['gemini', 'openrouter'] }),
      }),
      env,
      dummyCtx
    );
    expect(priorityRes.status).toBe(200);

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Quota exhausted RESOURCE_EXHAUSTED', { status: 429 }))
      .mockResolvedValueOnce(new Response('Second key rate limited', { status: 429 }))
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
      attempts: Array<{ provider: string; keyIndex?: number; success: boolean; rateLimited?: boolean }>;
    };
    expect(data.provider).toBe('openrouter');
    expect(data.text).toBe('Fallback response from OpenRouter');
    expect(data.attempts).toHaveLength(3);
    expect(data.attempts[0]).toMatchObject({ provider: 'gemini', keyIndex: 0, success: false, rateLimited: true });
    expect(data.attempts[1]).toMatchObject({ provider: 'gemini', keyIndex: 1, success: false, rateLimited: true });
    expect(data.attempts[2]).toMatchObject({ provider: 'openrouter', keyIndex: 0, success: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('processes persistent D1 jobs via Cron Triggers, enforces lock recovery, backoff, and Pause/Resume', async () => {
    const { env, tasks } = createTestEnv();

    // 1. Pause agent and enqueue a job -> Cron must NOT burn attempts while paused
    await workerEntry.fetch(
      new Request('https://worker.example/api/v1/agent/pause', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({ reason: 'Maintenance pause' }),
      }),
      env,
      dummyCtx
    );

    const enq = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/tasks/enqueue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({
          type: 'SEND_NOTIFICATION',
          payload: { title: 'D1 Queue', body: 'Executed via Cron' },
        }),
      }),
      env,
      dummyCtx
    );
    expect(enq.status).toBe(202);
    const enqJson = (await enq.json()) as { task: { id: string }; queueBackend: string };
    expect(enqJson.queueBackend).toBe('d1');

    // Run 15-min Cron while paused
    await workerEntry.scheduled(
      { cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      env,
      dummyCtx
    );
    await Promise.all(pendingWaitUntil);
    pendingWaitUntil.length = 0;

    expect(tasks.get(enqJson.task.id)?.status).toBe('queued');
    expect(tasks.get(enqJson.task.id)?.attempts).toBe(0);

    // 2. Simulate an expired lock on another processing job
    const staleId = 'stale-locked-job';
    tasks.set(staleId, {
      id: staleId,
      idempotency_key: null,
      type: 'SEND_NOTIFICATION',
      payload_json: JSON.stringify({ title: 'Recovered', body: 'Stale lock' }),
      status: 'processing',
      priority: 1,
      attempts: 1,
      max_attempts: 3,
      next_retry_at: null,
      locked_at: new Date(Date.now() - 300_000).toISOString(),
      locked_by: 'crashed-worker',
      lock_expires_at: new Date(Date.now() - 60_000).toISOString(),
      started_at: new Date(Date.now() - 300_000).toISOString(),
      last_error: null,
      result_json: null,
      created_by: 'test',
      created_at: new Date(Date.now() - 300_000).toISOString(),
      updated_at: new Date(Date.now() - 300_000).toISOString(),
      completed_at: null,
    });

    // 3. Resume agent -> Cron recovers stale lock and completes due jobs
    await workerEntry.fetch(
      new Request('https://worker.example/api/v1/agent/resume', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({ reason: 'Resuming' }),
      }),
      env,
      dummyCtx
    );

    await workerEntry.scheduled(
      { cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      env,
      dummyCtx
    );
    await Promise.all(pendingWaitUntil);
    pendingWaitUntil.length = 0;

    expect(tasks.get(staleId)?.status).toBe('completed');
    expect(tasks.get(enqJson.task.id)?.status).toBe('completed');

    // 4. Verify weekly cron enqueues all 3 weekly maintenance jobs into D1 & runs bounded batch
    await workerEntry.scheduled(
      { cron: '55 23 * * SUN', scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      env,
      dummyCtx
    );
    await Promise.all(pendingWaitUntil);

    const statsRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/tasks/stats', {
        headers: { 'X-API-Key': 'test-super-secret-api-key-123456' },
      }),
      env,
      dummyCtx
    );
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as { stats: { completed: number; total: number } };
    expect(statsBody.stats.completed).toBeGreaterThanOrEqual(5);
    expect(statsBody.stats.total).toBeGreaterThanOrEqual(5);
  });

  it('enforces SEO quality gate, alt text validation, and Adsterra device/density placement', async () => {
    const { env } = createTestEnv();

    const badSeoRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/seo/audit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({
          title: 'Short',
          metaDescription: 'Too short',
          htmlContent: '<p>Lorem ipsum dolor sit amet</p><img src="https://example.com/a.jpg" />',
          primaryKeyword: 'Cloudflare',
          minQualityWordCount: 50,
        }),
      }),
      env,
      dummyCtx
    );
    expect(badSeoRes.status).toBe(200);
    const badAudit = (await badSeoRes.json()) as {
      audit: { passedQualityGate: boolean; imagesMissingAlt: number };
    };
    expect(badAudit.audit.passedQualityGate).toBe(false);
    expect(badAudit.audit.imagesMissingAlt).toBe(1);

    const adSave = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/adsterra/configs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({
          id: 'slot-sec-1',
          name: 'Desktop Section Ad',
          placementType: 'between_sections',
          deviceTarget: 'desktop',
          scriptHtml: '<!-- adsterra-section -->',
          enabled: true,
        }),
      }),
      env,
      dummyCtx
    );
    expect(adSave.status).toBe(201);

    const preview = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/adsterra/preview-inject', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-super-secret-api-key-123456',
        },
        body: JSON.stringify({
          html: '<p>Intro paragraph</p><h2>Section 1</h2><p>Body</p><h2>Section 2</h2><p>More body</p>',
          deviceTarget: 'desktop',
        }),
      }),
      env,
      dummyCtx
    );
    expect(preview.status).toBe(200);
    const previewJson = (await preview.json()) as {
      html: string;
      structure: { headingCount: number; maxRecommendedAds: number };
    };
    expect(previewJson.structure.headingCount).toBe(2);
    expect(previewJson.html).toContain('data-device-target="desktop"');
    expect(previewJson.html).toContain('<!-- adsterra-section -->');
  });

  it('computes period-over-period traffic drop insights via GA4 & Search Console', async () => {
    const { env } = createTestEnv({
      GA4_PROPERTY_ID: '123456',
      GSC_SITE_URL: 'https://example.blogspot.com/',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), {
          status: 200,
        });
      }
      if (url.includes('analyticsdata.googleapis.com')) {
        const body = JSON.stringify({
          rows: [{ metricValues: [{ value: '500' }, { value: '300' }, { value: '250' }] }],
        });
        return new Response(body, { status: 200 });
      }
      if (url.includes('searchAnalytics/query')) {
        return new Response(
          JSON.stringify({
            rows: [
              { keys: ['https://example.blogspot.com/post-a'], clicks: 12, impressions: 200 },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    });

    const insightsRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/analytics/insights?days=7', {
        headers: { 'X-API-Key': 'test-super-secret-api-key-123456' },
      }),
      env,
      dummyCtx
    );
    expect(insightsRes.status).toBe(200);
    const insights = (await insightsRes.json()) as {
      periodDays: number;
      recommendations: string[];
    };
    expect(insights.periodDays).toBe(7);
    expect(insights.recommendations.length).toBeGreaterThan(0);
  });

  it('stores, retrieves, and deletes media assets in D1 without requiring R2', async () => {
    const { env } = createTestEnv();

    const uploadRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/media/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'X-API-Key': 'test-super-secret-api-key-123456',
          'X-Media-Key': 'posts/test-backup.txt',
        },
        body: 'Free-plan D1 media archive content',
      }),
      env,
      dummyCtx
    );
    expect(uploadRes.status).toBe(201);
    const uploadJson = (await uploadRes.json()) as { uploaded: { key: string; storage: string } };
    expect(uploadJson.uploaded.key).toBe('posts/test-backup.txt');
    expect(uploadJson.uploaded.storage).toBe('d1');

    const getRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/media/posts/test-backup.txt', {
        headers: { 'X-API-Key': 'test-super-secret-api-key-123456' },
      }),
      env,
      dummyCtx
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('Free-plan D1 media archive content');

    const delRes = await workerEntry.fetch(
      new Request('https://worker.example/api/v1/media/posts/test-backup.txt', {
        method: 'DELETE',
        headers: { 'X-API-Key': 'test-super-secret-api-key-123456' },
      }),
      env,
      dummyCtx
    );
    expect(delRes.status).toBe(204);
  });
});
