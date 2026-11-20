# AUTOBLOGGER AI — Cloud Run Backend

Production-ready Node.js + TypeScript + Express.js backend for **AUTOBLOGGER AI**, designed for stateless execution on **Google Cloud Run** with **Firebase Admin SDK**, **Firestore**, **Cloud Tasks**, **Cloud Scheduler**, **Google Blogger API v3**, **Google Search Console**, **Google Analytics 4**, **Adsterra**, **FCM**, and **Multi-Provider AI Failover** (Gemini, OpenRouter, API-NEX, Custom OpenAI-compatible).

---

## Directory Structure

```text
/backend
├── src/
│   ├── config/          # Zod-validated env config & Firebase Admin initialization
│   ├── middleware/      # Firebase/API-key auth, rate limiter, request logger, error handler
│   ├── routes/          # Express v1 routers (/health, /api/v1/*)
│   ├── services/        # AI failover, Blogger, SEO, GSC, GA4, Adsterra, FCM, Queue, Scheduler
│   ├── types/           # Shared TypeScript interfaces
│   ├── utils/           # Structured Cloud Logging & exponential backoff retry helper
│   ├── workers/         # Publish pipeline, persistent task runner, daily/weekly analytics
│   └── server.ts        # Express entrypoint (PORT, trust proxy, graceful shutdown)
├── android-integration/ # Kotlin GET /health verifier snippet for Android Setup Wizard
├── Dockerfile           # Multi-stage Node 20 Alpine Cloud Run container
├── .dockerignore
├── .env.example
├── package.json
├── tsconfig.json
├── DEPLOYMENT_GUIDE_BN.md
└── README.md
```

---

## API Endpoints

### Public Health & Discovery
- `GET /` — Service metadata
- `GET /health` — Cloud Run liveness & Android Setup Wizard verification (`200 OK` with `{ status: "ok", service, timestamp, firebaseConnected, agentStatus }`)

### Authenticated Endpoints (`/api/v1/*`)
Provide either:
- `Authorization: Bearer <Firebase_ID_Token>`
- `X-API-Key: <BACKEND_API_SECRET>`

| Module | Method & Path | Description |
| :--- | :--- | :--- |
| Health | `GET /api/v1/health/detailed` | Env diagnostics, Firebase status, AI provider circuit health (no secrets exposed) |
| Agent Control | `GET /api/v1/agent/status` | Current agent state (`running` \| `paused` \| `stopped`) |
| Agent Control | `POST /api/v1/agent/pause` | Pause autonomous publishing |
| Agent Control | `POST /api/v1/agent/resume` | Resume autonomous publishing |
| Agent Control | `POST /api/v1/agent/emergency-stop` | Immediately stop agent, cancel queued tasks, send FCM alert |
| AI Manager | `GET /api/v1/ai/providers/health` | Circuit breaker & latency state for Gemini, OpenRouter, API-NEX, Custom |
| AI Manager | `POST /api/v1/ai/generate` | Generate text/JSON with automatic multi-provider failover |
| Content | `POST /api/v1/content/research` | Keyword & outline research |
| Content | `POST /api/v1/content/generate` | Long-form SEO Blogger HTML article generation |
| Content | `POST /api/v1/content/publish-pipeline` | Full research -> generate -> SEO -> Adsterra -> Blogger -> FCM pipeline |
| SEO | `POST /api/v1/seo/audit` | Technical SEO score, keyword density, H1/H2 audit, JSON-LD generation |
| SEO | `POST /api/v1/seo/optimize-metadata` | AI-assisted title/meta/slug optimization |
| SEO | `POST /api/v1/seo/schema` | Generate Schema.org `BlogPosting` + `FAQPage` JSON-LD |
| Blogger | `GET /api/v1/blogger/blogs` | List Blogger blogs for connected Google account |
| Blogger | `GET /api/v1/blogger/posts` | List posts (`live`, `draft`, `scheduled`) |
| Blogger | `POST /api/v1/blogger/posts` | Publish or save draft post |
| Blogger | `PATCH /api/v1/blogger/posts/:postId` | Update post |
| Blogger | `DELETE /api/v1/blogger/posts/:postId` | Delete post |
| Analytics | `POST /api/v1/analytics/gsc/query` | Google Search Console Search Analytics query |
| Analytics | `GET /api/v1/analytics/gsc/sitemaps` | List GSC sitemaps |
| Analytics | `POST /api/v1/analytics/gsc/sitemaps/submit` | Submit sitemap URL |
| Analytics | `POST /api/v1/analytics/gsc/inspect` | URL Inspection API check |
| Analytics | `POST /api/v1/analytics/ga4/report` | Run GA4 Data API report |
| Analytics | `GET /api/v1/analytics/ga4/top-pages` | Top pages from GA4 |
| Analytics | `GET /api/v1/analytics/snapshots` | Stored daily/weekly Firestore snapshots |
| Adsterra | `GET /api/v1/adsterra/domains` | List Adsterra domains |
| Adsterra | `GET /api/v1/adsterra/placements` | List Adsterra placements |
| Adsterra | `GET /api/v1/adsterra/stats` | Revenue/impressions statistics |
| Adsterra | `GET/POST/DELETE /api/v1/adsterra/configs` | Manage ad injection slots in Firestore |
| Adsterra | `POST /api/v1/adsterra/preview-inject` | Preview HTML with ad slots injected |
| Scheduler | `GET/POST/DELETE /api/v1/scheduler/campaigns` | Manage autonomous publishing campaigns |
| Scheduler | `POST /api/v1/scheduler/tick` | Triggered by Cloud Scheduler (`X-Scheduler-Secret`) |
| Tasks | `GET /api/v1/tasks` & `GET /api/v1/tasks/:taskId` | Inspect persistent Firestore task queue |
| Tasks | `POST /api/v1/tasks/enqueue` | Enqueue persistent task (+ Cloud Tasks if enabled) |
| Tasks | `POST /api/v1/tasks/execute` | Cloud Tasks HTTP target handler |
| Tasks | `POST /api/v1/tasks/process-retries` | Cloud Scheduler retry sweep |
| Notifications | `POST /api/v1/notifications/tokens/register` | Register Android FCM device token |
| Notifications | `POST /api/v1/notifications/send` | Send push notification |
| Workers | `POST /api/v1/workers/analytics/daily` | Daily analytics aggregation job |
| Workers | `POST /api/v1/workers/analytics/weekly` | Weekly analytics aggregation job |
| Workers | `GET /api/v1/workers/logs` | Recent persistent system logs |

---

## Local Development

```bash
cd backend
cp .env.example .env
npm install
npm run check
npm run dev
```

Verify health locally:

```bash
curl http://localhost:8080/health
```

---

## Bengali Mobile + GitHub Deployment Guide

Read the complete step-by-step Bengali deployment guide in [DEPLOYMENT_GUIDE_BN.md](./DEPLOYMENT_GUIDE_BN.md).
