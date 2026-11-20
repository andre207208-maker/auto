# AUTOBLOGGER AI — Cloudflare Workers Backend

Production-ready **Cloudflare Workers + TypeScript + Hono + D1 + Cron Triggers** backend for **AUTOBLOGGER AI**, engineered 100% for the **Cloudflare Workers Free Plan** (no paid Queues, no R2 billing card required).

---

## Architecture Overview

| Layer | Technology | Binding / File |
| :--- | :--- | :--- |
| Edge HTTP & Cron | Cloudflare Workers + Hono | `src/index.ts` |
| Relational Persistence | Cloudflare D1 (SQLite) | `DB` (`migrations/0001_initial_schema.sql`, `migrations/0002_settings_and_ratelimits.sql`, `migrations/0003_d1_job_queue_and_media.sql`, `src/db/repositories.ts`) |
| Async Persistent Job Queue | D1 `task_queue` + Locking & Backoff | `src/services/taskQueueService.ts`, `src/workers/taskWorker.ts` |
| Scheduled Automation | Cloudflare Cron Triggers | `triggers.crons` (`*/15 * * * *`, `50 23 * * *`, `55 23 * * SUN`) |
| Free-Plan Media Archive | D1 `media_assets` table | `src/services/r2MediaService.ts` |
| Multi-Key AI Failover | Gemini, OpenRouter, API-NEX, Custom | `src/services/aiProviderManager.ts` (key rotation, D1 circuit breaker, priority override) |
| Web Research | Tavily Search API + AI Synthesis | `src/services/researchService.ts` |
| SEO Quality Gate | Audit, Alt Text, Canonical, JSON-LD & Anti-Duplicate | `src/services/seoService.ts` |
| Blogger / GSC / GA4 | Google OAuth2 + D1 Token Cache | `src/services/googleAuthService.ts` |
| Monetization | Adsterra API + Device-Targeted HTML Injector | `src/services/adsterraService.ts` |
| Push & Inbox Alerts | WebCrypto FCM HTTP v1 + D1 `notifications` | `src/services/fcmService.ts` |

### Free Plan Asynchronous Pipeline Design
To stay safely within Cloudflare Workers Free CPU/execution limits, `POST /api/v1/content/publish-pipeline` never runs research + generation + Blogger publishing synchronously in one HTTP call. Instead, it creates a `pipeline_runs` row in D1 and chains 3 small prioritized D1 jobs processed via Cron Triggers (max 3 jobs per Cron sweep, with atomic D1 locks and stale-lock recovery):
1. `PIPELINE_RESEARCH` (Tavily + AI keyword, search-intent & competition research)
2. `PIPELINE_GENERATE` (long-form HTML article generation with D1 internal link targets)
3. `PIPELINE_OPTIMIZE_AND_PUBLISH` (duplicate hash prevention, pre-publish quality gate, SEO audit + JSON-LD, structure-aware Adsterra injection, D1 HTML archive backup, Blogger publish, D1 & FCM notification)

---

## Android-Compatible REST API Contracts

### Public Health Verification (Setup Wizard)
- `GET /health` -> `200 OK`:
  ```json
  {
    "status": "ok",
    "service": "autoblogger-ai",
    "version": "2.0.0",
    "platform": "cloudflare-workers",
    "runtime": "cloudflare-workers",
    "environment": "production",
    "timestamp": "2026-11-20T06:00:00.000Z",
    "dbConnected": true,
    "queueConfigured": true,
    "r2Configured": true,
    "agentStatus": "running"
  }
  ```

### Authenticated Endpoints (`/api/v1/*`)
Send `X-API-Key: <BACKEND_API_SECRET>` or `Authorization: Bearer <Firebase_ID_Token>` (verified via Web Crypto JWKS):

- **Agent Control:** `GET /api/v1/agent/status`, `POST /api/v1/agent/pause`, `POST /api/v1/agent/resume`, `POST /api/v1/agent/emergency-stop`
- **AI Manager:** `GET /api/v1/ai/providers/health`, `GET /api/v1/ai/providers/priority`, `PUT /api/v1/ai/providers/priority`, `POST /api/v1/ai/providers/reset-health`, `POST /api/v1/ai/generate`
- **Content & Pipelines:** `POST /api/v1/content/discover-trending`, `POST /api/v1/content/research`, `POST /api/v1/content/generate` (`202` queued), `POST /api/v1/content/publish-pipeline` (`202` queued), `GET /api/v1/content/pipelines/:pipelineId`, `GET /api/v1/content/posts`
- **SEO:** `POST /api/v1/seo/audit`, `POST /api/v1/seo/optimize-metadata`, `POST /api/v1/seo/schema`
- **Blogger:** `GET /api/v1/blogger/blogs`, `GET /api/v1/blogger/blogs/:blogId`, `GET /api/v1/blogger/posts`, `POST /api/v1/blogger/posts`, `PATCH /api/v1/blogger/posts/:postId`, `DELETE /api/v1/blogger/posts/:postId`
- **Analytics & Traffic Insights:** `POST /api/v1/analytics/gsc/query`, `GET /api/v1/analytics/gsc/sitemaps`, `POST /api/v1/analytics/gsc/sitemaps/submit`, `POST /api/v1/analytics/gsc/inspect`, `POST /api/v1/analytics/ga4/report`, `GET /api/v1/analytics/ga4/top-pages`, `GET /api/v1/analytics/insights`, `GET /api/v1/analytics/snapshots`
- **Adsterra:** `GET /api/v1/adsterra/domains`, `GET /api/v1/adsterra/placements`, `GET /api/v1/adsterra/stats`, `GET/POST/DELETE /api/v1/adsterra/configs`, `POST /api/v1/adsterra/preview-inject`
- **Scheduler:** `GET/POST/DELETE /api/v1/scheduler/campaigns`, `POST /api/v1/scheduler/tick`
- **Tasks:** `GET /api/v1/tasks`, `GET /api/v1/tasks/:taskId`, `POST /api/v1/tasks/enqueue`, `POST /api/v1/tasks/process-retries`
- **Notifications:** `GET /api/v1/notifications`, `POST /api/v1/notifications/tokens/register`, `POST /api/v1/notifications/tokens/unregister`, `POST /api/v1/notifications/send`
- **Workers & Logs:** `POST /api/v1/workers/analytics/daily`, `POST /api/v1/workers/analytics/weekly`, `GET /api/v1/workers/logs`
- **R2 Media (Optional):** `POST /api/v1/media/upload`, `GET /api/v1/media/:key`, `DELETE /api/v1/media/:key`

---

## Local Development & Testing

```bash
cd backend
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run check
npm run dev
```

## Secrets Configuration (Production)

Never store API keys in `wrangler.jsonc` or GitHub. Configure secrets in Cloudflare Dashboard (**Workers & Pages -> autoblogger-ai-backend -> Settings -> Variables and Secrets**) or via CLI. Multiple API keys per provider can be comma-separated (`GEMINI_API_KEYS`, `OPENROUTER_API_KEYS`, `APINEX_API_KEYS`, `CUSTOM_AI_API_KEYS`):

```bash
npx wrangler secret put BACKEND_API_SECRET
npx wrangler secret put SCHEDULER_SHARED_SECRET
npx wrangler secret put GEMINI_API_KEYS
npx wrangler secret put OPENROUTER_API_KEYS
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
```

## GitHub Actions Deployment

Workflow: `/.github/workflows/cloudflare-deploy.yml`. Add these **GitHub Repository Secrets**:
- `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit, D1 Edit, Account Settings Read)
- `CLOUDFLARE_ACCOUNT_ID`

*(Important: No paid Cloudflare Queues or R2 bindings are required. You only need the D1 database `autoblogger-db` configured in `backend/wrangler.jsonc`.)*

## Bengali Deployment Guide

Read the complete Cloudflare Workers Dashboard Bengali guide in [DEPLOYMENT_GUIDE_BN.md](./DEPLOYMENT_GUIDE_BN.md).
