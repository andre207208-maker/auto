-- AUTOBLOGGER AI — Dynamic Settings & Edge Rate Limits
-- Migration: 0002_settings_and_ratelimits.sql

-- 13. Dynamic Runtime Settings (e.g., manual AI provider priority order, schedule config)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- 14. D1 Sliding-Window Rate Limiter
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
