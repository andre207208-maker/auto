-- AUTOBLOGGER AI — Cloudflare Free Plan Persistent D1 Job Queue & Media Fallback
-- Migration: 0003_d1_job_queue_and_media.sql
-- Preserves all existing tables and data in autoblogger-db.

-- 1. Add D1 job locking, priority, and execution timing columns to task_queue
ALTER TABLE task_queue ADD COLUMN locked_at TEXT;
ALTER TABLE task_queue ADD COLUMN locked_by TEXT;
ALTER TABLE task_queue ADD COLUMN lock_expires_at TEXT;
ALTER TABLE task_queue ADD COLUMN started_at TEXT;
ALTER TABLE task_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 5;

CREATE INDEX IF NOT EXISTS idx_task_queue_poll
  ON task_queue (status, priority ASC, next_retry_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_task_queue_lock_expires
  ON task_queue (status, lock_expires_at);

-- 2. Free-plan D1 media & article backup storage (replaces R2 bucket requirement)
CREATE TABLE IF NOT EXISTS media_assets (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  etag TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
