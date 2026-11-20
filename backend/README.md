# AUTOBLOGGER AI — Cloudflare Workers Backend

Production-ready **Cloudflare Workers + TypeScript + Hono + D1 + Queues + Cron Triggers + R2** backend for **AUTOBLOGGER AI**, migrated from Node.js/Express/Firebase/Cloud Run to Cloudflare's Free-compatible serverless edge architecture.

---

## Architecture Overview

| Layer | Technology | Binding / File |
| :--- | :--- | :--- |
| Edge HTTP / Queue / Cron | Cloudflare Workers + Hono | `src/index.ts` |
| Relational Persistence | Cloudflare D1 (SQLite) | `DB` (`migrations/0001_initial_schema.sql`, `src/db/repositories.ts`) |
| Async Jobs & Pipelines | Cloudflare Queues + D1 Idempotency | `TASK_QUEUE` (`src/services/taskQueueService.ts`, `src/workers/`) |
| Scheduled Automation | Cloudflare Cron Triggers | `triggers.crons` (`*/15 * * * *`, `50 23 * * *`, `55 23 * * 0`) |
| Optional Media Storage | Cloudflare R2 | `MEDIA_BUCKET` (`src/services/r2MediaService.ts`) |
| AI Failover | Gemini, OpenRouter, API-NEX, Custom | `src/services/aiProviderManager.ts` (D1 circuit breaker) |
| Web Research | Tavily Search API + AI Synthesis | `src/services/researchService.ts` |
| Blogger / GSC / GA4 | Google OAuth2 + D1 Token Cache | `src/services/googleAuthService.ts` |
| Monetization | Adsterra Publisher API + HTML Injector | `src/services/adsterraService.ts` |
| Push & Inbox Alerts | WebCrypto FCM HTTP v1 + D1 `notifications` | `src/services/fcmService.ts` |

### Free Plan Asynchronous Pipeline Design
To stay safely within Cloudflare Workers Free CPU/execution limits, `POST /api/v1/content/publish-pipeline` never runs research + generation + Blogger publishing synchronously in one HTTP call. Instead, it creates a `pipeline_runs` row in D1 and chains 3 small Queue stages:
1. `PIPELINE_RESEARCH` (Tavily + AI keyword/outline research)
2. `PIPELINE_GENERATE` (long-form HTML article generation)
3. `PIPELINE_OPTIMIZE_AND_PUBLISH` (SEO audit + JSON-LD + Adsterra injection + optional R2 HTML backup + Blogger publish + D1 + FCM notification)

---

## Android-Compatible REST API Contracts

### Public Health Verification (Setup Wizard)
- `GET /health` -> `200 OK`:
  ```json
  {
    "status": "ok",
    "service": "autoblogger-ai-backend",
    "version": "2.0.0",
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
- **AI Manager:** `GET /api/v1/ai/providers/health`, `POST /api/v1/ai/generate`
- **Content & Pipelines:** `POST /api/v1/content/research`, `POST /api/v1/content/generate` (`202` queued), `POST /api/v1/content/publish-pipeline` (`202` queued), `GET /api/v1/content/pipelines/:pipelineId`, `GET /api/v1/content/posts`
- **SEO:** `POST /api/v1/seo/audit`, `POST /api/v1/seo/optimize-metadata`, `POST /api/v1/seo/schema`
- **Blogger:** `GET /api/v1/blogger/blogs`, `GET /api/v1/blogger/blogs/:blogId`, `GET /api/v1/blogger/posts`, `POST /api/v1/blogger/posts`, `PATCH /api/v1/blogger/posts/:postId`, `DELETE /api/v1/blogger/posts/:postId`
- **Analytics:** `POST /api/v1/analytics/gsc/query`, `GET /api/v1/analytics/gsc/sitemaps`, `POST /api/v1/analytics/gsc/sitemaps/submit`, `POST /api/v1/analytics/gsc/inspect`, `POST /api/v1/analytics/ga4/report`, `GET /api/v1/analytics/ga4/top-pages`, `GET /api/v1/analytics/snapshots`
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

Never store API keys in `wrangler.jsonc` or GitHub. Configure secrets in Cloudflare Dashboard (**Workers & Pages -> autoblogger-ai-backend -> Settings -> Variables and Secrets**) or via CLI:

```bash
npx wrangler secret put BACKEND_API_SECRET
npx wrangler secret put SCHEDULER_SHARED_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
```

## GitHub Actions Deployment

Workflow: `/.github/workflows/deploy-cloudflare-worker.yml`. Add these **GitHub Repository Secrets**:
- `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit, D1 Edit, Queues Edit, R2 Edit)
- `CLOUDFLARE_ACCOUNT_ID`

## Bengali Deployment Guide

Read the complete Cloudflare Workers Dashboard Bengali guide in [DEPLOYMENT_GUIDE_BN.md](./DEPLOYMENT_GUIDE_BN.md).
