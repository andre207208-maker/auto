import {
  AIProviderHealth,
  AIProviderName,
  AdsterraPlacementConfig,
  AgentControlState,
  AgentStatus,
  CampaignSchedule,
  PersistentTask,
  PipelineRun,
  PipelineStage,
  TaskStatus,
  TaskType,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

export async function checkDbHealth(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return row?.ok === 1;
  } catch {
    return false;
  }
}

export async function logSystemEvent(
  db: D1Database,
  level: 'info' | 'warn' | 'error' | 'critical',
  category: string,
  message: string,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO system_logs (id, level, category, message, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        level,
        category,
        message,
        details ? JSON.stringify(details) : null,
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    logger.warn('Failed to persist system event to D1', {
      category,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function listRecentSystemLogs(
  db: D1Database,
  limit = 50
): Promise<Array<Record<string, unknown>>> {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const res = await db
    .prepare(
      `SELECT id, level, category, message, details_json, created_at
       FROM system_logs ORDER BY created_at DESC LIMIT ?`
    )
    .bind(safeLimit)
    .all<{
      id: string;
      level: string;
      category: string;
      message: string;
      details_json: string | null;
      created_at: string;
    }>();

  return res.results.map((r) => ({
    id: r.id,
    level: r.level,
    category: r.category,
    message: r.message,
    details: r.details_json ? JSON.parse(r.details_json) : null,
    createdAt: r.created_at,
  }));
}

// ============================================================================
// Agent State Repository
// ============================================================================
export async function getAgentStateRow(db: D1Database): Promise<AgentControlState> {
  const row = await db
    .prepare(
      `SELECT status, emergency_stop, reason, updated_by, updated_at
       FROM agent_state WHERE id = 'agent'`
    )
    .first<{
      status: AgentStatus;
      emergency_stop: number;
      reason: string | null;
      updated_by: string | null;
      updated_at: string;
    }>();

  if (!row) {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT OR IGNORE INTO agent_state (id, status, emergency_stop, reason, updated_by, updated_at)
         VALUES ('agent', 'running', 0, 'Initial boot', 'system', ?)`
      )
      .bind(now)
      .run();

    return { status: 'running', emergencyStop: false, reason: 'Initial boot', updatedAt: now };
  }

  return {
    status: row.status,
    emergencyStop: row.emergency_stop === 1,
    reason: row.reason,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export async function saveAgentStateRow(
  db: D1Database,
  state: AgentControlState
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_state (id, status, emergency_stop, reason, updated_by, updated_at)
       VALUES ('agent', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         emergency_stop = excluded.emergency_stop,
         reason = excluded.reason,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
    .bind(
      state.status,
      state.emergencyStop ? 1 : 0,
      state.reason ?? null,
      state.updatedBy ?? null,
      state.updatedAt
    )
    .run();
}

export async function cancelPendingTasksForEmergencyStop(
  db: D1Database,
  reason: string
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE task_queue
       SET status = 'cancelled', last_error = ?, updated_at = ?
       WHERE status IN ('queued', 'retrying')`
    )
    .bind(reason, now)
    .run();

  await db
    .prepare(
      `UPDATE pipeline_runs
       SET stage = 'cancelled', error_message = ?, updated_at = ?
       WHERE stage NOT IN ('completed', 'failed', 'cancelled')`
    )
    .bind(reason, now)
    .run();

  return res.meta.changes ?? 0;
}

// ============================================================================
// AI Provider Health Repository
// ============================================================================
export async function listProviderHealthRows(
  db: D1Database
): Promise<Record<string, AIProviderHealth>> {
  const res = await db
    .prepare(
      `SELECT provider, configured, healthy, consecutive_failures, circuit_open_until,
              last_error, last_success_at, last_failure_at, average_latency_ms
       FROM ai_provider_health`
    )
    .all<{
      provider: AIProviderName;
      configured: number;
      healthy: number;
      consecutive_failures: number;
      circuit_open_until: number | null;
      last_error: string | null;
      last_success_at: string | null;
      last_failure_at: string | null;
      average_latency_ms: number | null;
    }>();

  const map: Record<string, AIProviderHealth> = {};
  for (const r of res.results) {
    map[r.provider] = {
      provider: r.provider,
      configured: r.configured === 1,
      healthy: r.healthy === 1,
      consecutiveFailures: r.consecutive_failures,
      circuitOpenUntil: r.circuit_open_until,
      lastError: r.last_error,
      lastSuccessAt: r.last_success_at,
      lastFailureAt: r.last_failure_at,
      averageLatencyMs: r.average_latency_ms,
    };
  }
  return map;
}

export async function upsertProviderHealthRow(
  db: D1Database,
  health: AIProviderHealth
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_provider_health (
         provider, configured, healthy, consecutive_failures, circuit_open_until,
         last_error, last_success_at, last_failure_at, average_latency_ms, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         configured = excluded.configured,
         healthy = excluded.healthy,
         consecutive_failures = excluded.consecutive_failures,
         circuit_open_until = excluded.circuit_open_until,
         last_error = excluded.last_error,
         last_success_at = excluded.last_success_at,
         last_failure_at = excluded.last_failure_at,
         average_latency_ms = excluded.average_latency_ms,
         updated_at = excluded.updated_at`
    )
    .bind(
      health.provider,
      health.configured ? 1 : 0,
      health.healthy ? 1 : 0,
      health.consecutiveFailures,
      health.circuitOpenUntil,
      health.lastError ?? null,
      health.lastSuccessAt ?? null,
      health.lastFailureAt ?? null,
      health.averageLatencyMs ?? null,
      new Date().toISOString()
    )
    .run();
}

// ============================================================================
// Task Queue Repository (Idempotent & Atomic Claim)
// ============================================================================
interface TaskRow {
  id: string;
  idempotency_key: string | null;
  type: TaskType;
  payload_json: string;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  result_json: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapTaskRow(row: TaskRow): PersistentTask {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export async function insertTaskIfNew(
  db: D1Database,
  task: PersistentTask
): Promise<{ task: PersistentTask; duplicate: boolean }> {
  if (task.idempotencyKey) {
    const existing = await db
      .prepare(`SELECT * FROM task_queue WHERE idempotency_key = ?`)
      .bind(task.idempotencyKey)
      .first<TaskRow>();
    if (existing) {
      return { task: mapTaskRow(existing), duplicate: true };
    }
  }

  await db
    .prepare(
      `INSERT INTO task_queue (
         id, idempotency_key, type, payload_json, status, attempts, max_attempts,
         next_retry_at, last_error, result_json, created_by, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      task.id,
      task.idempotencyKey ?? null,
      task.type,
      JSON.stringify(task.payload),
      task.status,
      task.attempts,
      task.maxAttempts,
      task.nextRetryAt,
      task.lastError,
      task.result ? JSON.stringify(task.result) : null,
      task.createdBy,
      task.createdAt,
      task.updatedAt,
      task.completedAt ?? null
    )
    .run();

  return { task, duplicate: false };
}

export async function getTaskRowById(
  db: D1Database,
  taskId: string
): Promise<PersistentTask | null> {
  const row = await db.prepare(`SELECT * FROM task_queue WHERE id = ?`).bind(taskId).first<TaskRow>();
  return row ? mapTaskRow(row) : null;
}

export async function listTaskRows(
  db: D1Database,
  options?: { status?: TaskStatus; limit?: number }
): Promise<PersistentTask[]> {
  const safeLimit = Math.min(Math.max(1, options?.limit ?? 50), 200);
  if (options?.status) {
    const res = await db
      .prepare(`SELECT * FROM task_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(options.status, safeLimit)
      .all<TaskRow>();
    return res.results.map(mapTaskRow);
  }
  const res = await db
    .prepare(`SELECT * FROM task_queue ORDER BY created_at DESC LIMIT ?`)
    .bind(safeLimit)
    .all<TaskRow>();
  return res.results.map(mapTaskRow);
}

export async function claimTaskAtomically(
  db: D1Database,
  taskId: string
): Promise<PersistentTask | null> {
  const now = new Date().toISOString();
  const updateRes = await db
    .prepare(
      `UPDATE task_queue
       SET status = 'processing', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'retrying')`
    )
    .bind(now, taskId)
    .run();

  if ((updateRes.meta.changes ?? 0) === 0) {
    return null;
  }

  return getTaskRowById(db, taskId);
}

export async function completeTaskRow(
  db: D1Database,
  taskId: string,
  result: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE task_queue
       SET status = 'completed', result_json = ?, last_error = NULL,
           next_retry_at = NULL, completed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(JSON.stringify(result), now, now, taskId)
    .run();
}

export async function failOrRetryTaskRow(
  db: D1Database,
  task: PersistentTask,
  errorMessage: string
): Promise<{ status: TaskStatus; delaySeconds: number }> {
  const now = new Date();
  const exhausted = task.attempts >= task.maxAttempts;
  if (exhausted) {
    await db
      .prepare(
        `UPDATE task_queue
         SET status = 'dead_letter', last_error = ?, next_retry_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .bind(errorMessage, now.toISOString(), task.id)
      .run();
    return { status: 'dead_letter', delaySeconds: 0 };
  }

  const delaySeconds = Math.min(3600, 30 * Math.pow(4, Math.max(0, task.attempts - 1)));
  const nextRetryAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  await db
    .prepare(
      `UPDATE task_queue
       SET status = 'retrying', last_error = ?, next_retry_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(errorMessage, nextRetryAt, now.toISOString(), task.id)
    .run();
  return { status: 'retrying', delaySeconds };
}

export async function listDueTaskRows(db: D1Database, limit = 15): Promise<PersistentTask[]> {
  const nowIso = new Date().toISOString();
  const res = await db
    .prepare(
      `SELECT * FROM task_queue
       WHERE status IN ('queued', 'retrying')
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .bind(nowIso, limit)
    .all<TaskRow>();
  return res.results.map(mapTaskRow);
}

// ============================================================================
// Pipeline Runs Repository
// ============================================================================
interface PipelineRow {
  id: string;
  campaign_id: string | null;
  stage: PipelineStage;
  niche: string;
  seed_keyword: string | null;
  blog_id: string | null;
  language: string;
  tone: string | null;
  publish_as_draft: number;
  inject_ads: number;
  preferred_provider: AIProviderName | null;
  research_json: string | null;
  article_json: string | null;
  seo_json: string | null;
  result_json: string | null;
  error_message: string | null;
  triggered_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapPipelineRow(row: PipelineRow): PipelineRun {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    stage: row.stage,
    niche: row.niche,
    seedKeyword: row.seed_keyword,
    blogId: row.blog_id,
    language: row.language,
    tone: row.tone,
    publishAsDraft: row.publish_as_draft === 1,
    injectAds: row.inject_ads === 1,
    preferredProvider: row.preferred_provider,
    research: row.research_json ? JSON.parse(row.research_json) : null,
    article: row.article_json ? JSON.parse(row.article_json) : null,
    seo: row.seo_json ? JSON.parse(row.seo_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export async function createPipelineRun(
  db: D1Database,
  run: Omit<PipelineRun, 'createdAt' | 'updatedAt'>
): Promise<PipelineRun> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO pipeline_runs (
         id, campaign_id, stage, niche, seed_keyword, blog_id, language, tone,
         publish_as_draft, inject_ads, preferred_provider, triggered_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      run.id,
      run.campaignId ?? null,
      run.stage,
      run.niche,
      run.seedKeyword ?? null,
      run.blogId ?? null,
      run.language,
      run.tone ?? null,
      run.publishAsDraft ? 1 : 0,
      run.injectAds ? 1 : 0,
      run.preferredProvider ?? null,
      run.triggeredBy,
      now,
      now
    )
    .run();
  return { ...run, createdAt: now, updatedAt: now };
}

export async function getPipelineRunById(
  db: D1Database,
  id: string
): Promise<PipelineRun | null> {
  const row = await db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).bind(id).first<PipelineRow>();
  return row ? mapPipelineRow(row) : null;
}

export async function updatePipelineRun(
  db: D1Database,
  id: string,
  patch: {
    stage: PipelineStage;
    research?: unknown;
    article?: unknown;
    seo?: unknown;
    result?: unknown;
    errorMessage?: string | null;
    completedAt?: string | null;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE pipeline_runs
       SET stage = ?,
           research_json = COALESCE(?, research_json),
           article_json = COALESCE(?, article_json),
           seo_json = COALESCE(?, seo_json),
           result_json = COALESCE(?, result_json),
           error_message = ?,
           completed_at = COALESCE(?, completed_at),
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      patch.stage,
      patch.research !== undefined ? JSON.stringify(patch.research) : null,
      patch.article !== undefined ? JSON.stringify(patch.article) : null,
      patch.seo !== undefined ? JSON.stringify(patch.seo) : null,
      patch.result !== undefined ? JSON.stringify(patch.result) : null,
      patch.errorMessage ?? null,
      patch.completedAt ?? null,
      now,
      id
    )
    .run();
}

// ============================================================================
// Campaigns, Posts, Adsterra, Notifications, Analytics Snapshots
// ============================================================================
export async function listCampaignRows(
  db: D1Database,
  onlyEnabled = false
): Promise<CampaignSchedule[]> {
  const sql = onlyEnabled
    ? `SELECT * FROM campaigns WHERE enabled = 1 ORDER BY created_at DESC`
    : `SELECT * FROM campaigns ORDER BY created_at DESC`;
  const res = await db.prepare(sql).all<{
    id: string;
    name: string;
    niche: string;
    blog_id: string;
    enabled: number;
    cron_expression: string;
    posts_per_day: number;
    publish_as_draft: number;
    inject_ads: number;
    preferred_provider: AIProviderName | null;
    language: string;
    target_keywords_json: string;
    last_run_at: string | null;
    posts_published_today: number;
    last_reset_date: string | null;
    created_at: string;
    updated_at: string;
  }>();

  return res.results.map((r) => ({
    id: r.id,
    name: r.name,
    niche: r.niche,
    blogId: r.blog_id,
    enabled: r.enabled === 1,
    cronExpression: r.cron_expression,
    postsPerDay: r.posts_per_day,
    publishAsDraft: r.publish_as_draft === 1,
    injectAds: r.inject_ads === 1,
    preferredProvider: r.preferred_provider ?? undefined,
    language: r.language,
    targetKeywords: JSON.parse(r.target_keywords_json || '[]'),
    lastRunAt: r.last_run_at,
    postsPublishedToday: r.posts_published_today,
    lastResetDate: r.last_reset_date ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function upsertCampaignRow(
  db: D1Database,
  campaign: CampaignSchedule
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO campaigns (
         id, name, niche, blog_id, enabled, cron_expression, posts_per_day,
         publish_as_draft, inject_ads, preferred_provider, language, target_keywords_json,
         last_run_at, posts_published_today, last_reset_date, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         niche = excluded.niche,
         blog_id = excluded.blog_id,
         enabled = excluded.enabled,
         cron_expression = excluded.cron_expression,
         posts_per_day = excluded.posts_per_day,
         publish_as_draft = excluded.publish_as_draft,
         inject_ads = excluded.inject_ads,
         preferred_provider = excluded.preferred_provider,
         language = excluded.language,
         target_keywords_json = excluded.target_keywords_json,
         last_run_at = excluded.last_run_at,
         posts_published_today = excluded.posts_published_today,
         last_reset_date = excluded.last_reset_date,
         updated_at = excluded.updated_at`
    )
    .bind(
      campaign.id,
      campaign.name,
      campaign.niche,
      campaign.blogId,
      campaign.enabled ? 1 : 0,
      campaign.cronExpression,
      campaign.postsPerDay,
      campaign.publishAsDraft ? 1 : 0,
      campaign.injectAds ? 1 : 0,
      campaign.preferredProvider ?? null,
      campaign.language,
      JSON.stringify(campaign.targetKeywords),
      campaign.lastRunAt ?? null,
      campaign.postsPublishedToday,
      campaign.lastResetDate ?? null,
      campaign.createdAt,
      campaign.updatedAt
    )
    .run();
}

export async function deleteCampaignRow(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM campaigns WHERE id = ?`).bind(id).run();
}

export async function updateCampaignQuotaRow(
  db: D1Database,
  id: string,
  countToday: number,
  resetDate: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE campaigns
       SET posts_published_today = ?, last_reset_date = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(countToday, resetDate, now, now, id)
    .run();
}

export async function insertPostRecord(
  db: D1Database,
  post: {
    id: string;
    pipelineId?: string | null;
    campaignId?: string | null;
    blogId: string;
    bloggerPostId: string;
    bloggerUrl: string;
    title: string;
    slug: string;
    metaDescription: string;
    primaryKeyword: string;
    secondaryKeywords: string[];
    labels: string[];
    wordCount: number;
    seoScore: number;
    providerUsed: string;
    modelUsed: string;
    isDraft: boolean;
    r2AssetKey?: string | null;
    triggeredBy: string;
    publishedAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO posts (
         id, pipeline_id, campaign_id, blog_id, blogger_post_id, blogger_url,
         title, slug, meta_description, primary_keyword, secondary_keywords_json,
         labels_json, word_count, seo_score, provider_used, model_used,
         is_draft, r2_asset_key, triggered_by, published_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      post.id,
      post.pipelineId ?? null,
      post.campaignId ?? null,
      post.blogId,
      post.bloggerPostId,
      post.bloggerUrl,
      post.title,
      post.slug,
      post.metaDescription,
      post.primaryKeyword,
      JSON.stringify(post.secondaryKeywords),
      JSON.stringify(post.labels),
      post.wordCount,
      post.seoScore,
      post.providerUsed,
      post.modelUsed,
      post.isDraft ? 1 : 0,
      post.r2AssetKey ?? null,
      post.triggeredBy,
      post.publishedAt
    )
    .run();
}

export async function listPostRecords(
  db: D1Database,
  limit = 25
): Promise<Array<Record<string, unknown>>> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const res = await db
    .prepare(`SELECT * FROM posts ORDER BY published_at DESC LIMIT ?`)
    .bind(safeLimit)
    .all<Record<string, unknown>>();
  return res.results;
}

export async function listAdConfigRows(db: D1Database): Promise<AdsterraPlacementConfig[]> {
  const res = await db
    .prepare(`SELECT * FROM ad_configs ORDER BY updated_at DESC`)
    .all<{
      id: string;
      name: string;
      placement_type: AdsterraPlacementConfig['placementType'];
      script_html: string;
      enabled: number;
      insert_after_paragraph: number | null;
      updated_at: string;
    }>();

  return res.results.map((r) => ({
    id: r.id,
    name: r.name,
    placementType: r.placement_type,
    scriptHtml: r.script_html,
    enabled: r.enabled === 1,
    insertAfterParagraph: r.insert_after_paragraph ?? undefined,
    updatedAt: r.updated_at,
  }));
}

export async function upsertAdConfigRow(
  db: D1Database,
  cfg: AdsterraPlacementConfig
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ad_configs (id, name, placement_type, script_html, enabled, insert_after_paragraph, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         placement_type = excluded.placement_type,
         script_html = excluded.script_html,
         enabled = excluded.enabled,
         insert_after_paragraph = excluded.insert_after_paragraph,
         updated_at = excluded.updated_at`
    )
    .bind(
      cfg.id,
      cfg.name,
      cfg.placementType,
      cfg.scriptHtml,
      cfg.enabled ? 1 : 0,
      cfg.insertAfterParagraph ?? null,
      cfg.updatedAt
    )
    .run();
}

export async function deleteAdConfigRow(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM ad_configs WHERE id = ?`).bind(id).run();
}
