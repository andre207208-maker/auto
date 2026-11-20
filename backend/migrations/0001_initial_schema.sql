-- AUTOBLOGGER AI — Cloudflare D1 Initial Schema
-- Migration: 0001_initial_schema.sql

PRAGMA foreign_keys = ON;

-- 1. Global Agent Control State (pause, resume, emergency stop)
CREATE TABLE IF NOT EXISTS agent_state (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopped')),
  emergency_stop INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO agent_state (id, status, emergency_stop, reason, updated_by, updated_at)
VALUES ('agent', 'running', 0, 'Initial boot', 'system', datetime('now'));

-- 2. AI Provider Circuit Breaker & Health State
CREATE TABLE IF NOT EXISTS ai_provider_health (
  provider TEXT PRIMARY KEY,
  configured INTEGER NOT NULL DEFAULT 0,
  healthy INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_open_until INTEGER,
  last_error TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  average_latency_ms INTEGER,
  updated_at TEXT NOT NULL
);

-- 3. Autonomous Publishing Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niche TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cron_expression TEXT NOT NULL DEFAULT '0 */6 * * *',
  posts_per_day INTEGER NOT NULL DEFAULT 2,
  publish_as_draft INTEGER NOT NULL DEFAULT 0,
  inject_ads INTEGER NOT NULL DEFAULT 1,
  preferred_provider TEXT,
  language TEXT NOT NULL DEFAULT 'English',
  target_keywords_json TEXT NOT NULL DEFAULT '[]',
  last_run_at TEXT,
  posts_published_today INTEGER NOT NULL DEFAULT 0,
  last_reset_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_campaigns_enabled ON campaigns (enabled);

-- 4. Multi-Stage Async Pipeline Runs (breaks long AI tasks for Cloudflare Free plan limits)
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('research_queued', 'research_done', 'generate_queued', 'generate_done', 'publish_queued', 'completed', 'failed', 'cancelled')),
  niche TEXT NOT NULL,
  seed_keyword TEXT,
  blog_id TEXT,
  language TEXT NOT NULL DEFAULT 'English',
  tone TEXT,
  publish_as_draft INTEGER NOT NULL DEFAULT 0,
  inject_ads INTEGER NOT NULL DEFAULT 1,
  preferred_provider TEXT,
  research_json TEXT,
  article_json TEXT,
  seo_json TEXT,
  result_json TEXT,
  error_message TEXT,
  triggered_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_stage ON pipeline_runs (stage, updated_at DESC);

-- 5. Published Blogger Posts
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT,
  campaign_id TEXT,
  blog_id TEXT NOT NULL,
  blogger_post_id TEXT NOT NULL,
  blogger_url TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  meta_description TEXT NOT NULL DEFAULT '',
  primary_keyword TEXT NOT NULL,
  secondary_keywords_json TEXT NOT NULL DEFAULT '[]',
  labels_json TEXT NOT NULL DEFAULT '[]',
  word_count INTEGER NOT NULL DEFAULT 0,
  seo_score INTEGER NOT NULL DEFAULT 0,
  provider_used TEXT NOT NULL,
  model_used TEXT NOT NULL,
  is_draft INTEGER NOT NULL DEFAULT 0,
  r2_asset_key TEXT,
  triggered_by TEXT NOT NULL,
  published_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_campaign_id ON posts (campaign_id);

-- 6. Persistent Task Queue with Idempotency & Retry State
CREATE TABLE IF NOT EXISTS task_queue (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'retrying', 'completed', 'dead_letter', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  next_retry_at TEXT,
  last_error TEXT,
  result_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_queue_status_retry ON task_queue (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_task_queue_created_at ON task_queue (created_at DESC);

-- 7. Adsterra Ad Injection Configurations
CREATE TABLE IF NOT EXISTS ad_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  placement_type TEXT NOT NULL CHECK (placement_type IN ('top_banner', 'mid_article', 'bottom_banner', 'social_bar', 'native_banner')),
  script_html TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  insert_after_paragraph INTEGER,
  updated_at TEXT NOT NULL
);

-- 8. Daily & Weekly Analytics Snapshots
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  published_posts_count INTEGER NOT NULL DEFAULT 0,
  sources_json TEXT NOT NULL,
  errors_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_generated_at ON analytics_snapshots (generated_at DESC);

-- 9. Android FCM Device Tokens
CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  uid TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT 'Android Device',
  platform TEXT NOT NULL DEFAULT 'android',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- 10. Notification History (allows Android polling + FCM delivery tracking)
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'autoblogger_alerts',
  data_json TEXT,
  fcm_dispatched INTEGER NOT NULL DEFAULT 0,
  devices_targeted INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

-- 11. Cached Google OAuth Access Tokens (avoids redundant OAuth refreshes across Worker isolates)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- 12. Structured Persistent System Logs
CREATE TABLE IF NOT EXISTS system_logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error', 'critical')),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs (created_at DESC);
