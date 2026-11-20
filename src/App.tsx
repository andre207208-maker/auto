import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Code2,
  Copy,
  Check,
  Database,
  FileText,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Terminal,
} from 'lucide-react';

interface HealthResponse {
  status?: string;
  service?: string;
  version?: string;
  runtime?: string;
  environment?: string;
  timestamp?: string;
  dbConnected?: boolean;
  queueConfigured?: boolean;
  r2Configured?: boolean;
  agentStatus?: string;
}

const CAPABILITIES = [
  { id: '01', name: 'Workers Fetch + GET /health', module: 'index.ts / healthRoutes.ts', desc: 'Zero-cold-start Edge Worker handler & Android Setup Wizard /health verification' },
  { id: '02', name: 'WebCrypto Auth & API Key', module: 'middleware/auth.ts', desc: 'Firebase JWT JWKS verify via crypto.subtle + timing-safe X-API-Key & Scheduler secret' },
  { id: '03', name: 'Cloudflare D1 Persistence', module: 'db/repositories.ts', desc: '12 relational SQLite tables via DB binding & SQL migrations (0001_initial_schema.sql)' },
  { id: '04', name: 'Cloudflare Queues Pipeline', module: 'workers/publishWorker.ts', desc: '3-stage async Queue chain (Research -> Generate -> Publish) for Free plan limits' },
  { id: '05', name: 'Cloudflare Cron Triggers', module: 'workers/taskWorker.ts', desc: 'Scheduled */15 scheduler/retries + daily & weekly analytics aggregation' },
  { id: '06', name: 'AI Provider Failover', module: 'services/aiProviderManager.ts', desc: 'Gemini REST, OpenRouter, API-NEX & Custom OpenAI with D1 circuit breaker' },
  { id: '07', name: 'Tavily + AI Research', module: 'services/researchService.ts', desc: 'Live Tavily Web Search API grounding + structured keyword & outline synthesis' },
  { id: '08', name: 'SEO Audit & JSON-LD', module: 'services/seoService.ts', desc: 'Keyword density, heading audit, AI meta rewrite & BlogPosting/FAQPage Schema' },
  { id: '09', name: 'Blogger OAuth2 & API v3', module: 'services/bloggerService.ts', desc: 'D1-cached Google OAuth token refresh + blog/post CRUD & draft publishing' },
  { id: '10', name: 'Search Console & GA4', module: 'services/searchConsoleService.ts', desc: 'Search Analytics, sitemap submission, URL Inspection & GA4 Data API reports' },
  { id: '11', name: 'Adsterra Ad Injection', module: 'services/adsterraService.ts', desc: 'Publisher API v3 stats + D1 slot configs & paragraph-safe HTML injection' },
  { id: '12', name: 'Idempotency & Retries', module: 'services/taskQueueService.ts', desc: 'Unique idempotency_key deduplication, atomic claim, backoff & dead-letter queue' },
  { id: '13', name: 'Pause / Resume / E-Stop', module: 'services/agentControlService.ts', desc: 'D1-backed control plane cancelling pending tasks & pipelines on Emergency Stop' },
  { id: '14', name: 'FCM & D1 Notifications', module: 'services/fcmService.ts', desc: 'WebCrypto FCM HTTP v1 push delivery + persistent D1 notification inbox' },
  { id: '15', name: 'Optional Cloudflare R2', module: 'services/r2MediaService.ts', desc: 'MEDIA_BUCKET binding for HTML article backups and media asset storage' },
  { id: '16', name: 'GitHub Actions CI/CD', module: '.github/workflows/', desc: 'Automated lint, Vitest, D1 migration apply & wrangler deploy via GitHub Secrets' },
];

const KOTLIN_SNIPPET = `// Drop into your Android Setup Wizard: /backend/android-integration/CloudRunHealthVerifier.kt
val result = CloudRunHealthVerifier.verifyBackend(userEnteredWorkerUrl)
if (result.verified) {
    // Save result.normalizedBaseUrl (e.g. https://autoblogger-ai-backend.<user>.workers.dev)
} else {
    // Show result.errorMessage — never accept unverified URLs
}`;

const BENGALI_STEPS = [
  {
    step: '১. Cloudflare D1 ডাটাবেস তৈরি (Dashboard থেকে)',
    detail: 'dash.cloudflare.com-এ লগইন করে Storage & Databases > D1 SQL Database > Create Database ("autoblogger-db") তৈরি করুন। প্রাপ্ত Database ID-টি backend/wrangler.jsonc ফাইলে বসান এবং migrations/0001_initial_schema.sql রান করুন।',
  },
  {
    step: '২. Cloudflare Queues ও R2 Bucket তৈরি',
    detail: 'Storage & Databases > Queues থেকে "autoblogger-tasks" ও "autoblogger-tasks-dlq" তৈরি করুন। ইমেজ/HTML ব্যাকআপের জন্য R2 থেকে "autoblogger-media" Bucket তৈরি করুন।',
  },
  {
    step: '৩. Cloudflare Workers-এ GitHub সংযুক্ত করুন',
    detail: 'Compute (Workers) > Workers & Pages > Create > Connect to Git সিলেক্ট করে আপনার GitHub রিপোজিটরি দিন (Path: backend, Deploy: npx wrangler deploy) অথবা .github/workflows/deploy-cloudflare-worker.yml ব্যবহার করুন।',
  },
  {
    step: '৪. Cloudflare Secrets যোগ করুন',
    detail: 'Worker Settings > Variables and Secrets থেকে BACKEND_API_SECRET, SCHEDULER_SHARED_SECRET, GEMINI_API_KEY, TAVILY_API_KEY, GOOGLE_OAUTH_* ও ADSTERRA_API_KEY সেট করুন।',
  },
  {
    step: '৫. Worker URL সংগ্রহ ও Android Setup Wizard-এ যাচাই',
    detail: 'ডিপ্লয় শেষে পাওয়া https://autoblogger-ai-backend.<subdomain>.workers.dev URL-টি Android Setup Wizard-এ দিন। অ্যাপটি GET /health যাচাই করে status: "ok" ও dbConnected: true পেলেই সংযোগ সম্পন্ন হবে।',
  },
];

type TabKey = 'verifier' | 'architecture' | 'bengali-guide' | 'android-kotlin';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('verifier');
  const [backendUrl, setBackendUrl] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyState, setVerifyState] = useState<{
    checked: boolean;
    verified: boolean;
    statusCode?: number;
    payload?: HealthResponse;
    error?: string;
    latencyMs?: number;
  } | null>(null);
  const [copiedKotlin, setCopiedKotlin] = useState(false);

  async function handleVerifyHealth(e: React.FormEvent) {
    e.preventDefault();
    const normalized = backendUrl.trim().replace(/\/+$/, '');
    if (!normalized) {
      setVerifyState({
        checked: true,
        verified: false,
        error: 'Enter your deployed Cloudflare Worker HTTPS URL first (no fake URLs are prefilled).',
      });
      return;
    }

    if (!/^https?:\/\/.+/.test(normalized)) {
      setVerifyState({
        checked: true,
        verified: false,
        error: 'URL must start with https:// (or http:// for local wrangler dev testing).',
      });
      return;
    }

    setVerifying(true);
    const started = performance.now();
    try {
      const response = await fetch(`${normalized}/health`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const latencyMs = Math.round(performance.now() - started);

      let data: HealthResponse | undefined;
      try {
        data = (await response.json()) as HealthResponse;
      } catch {
        data = undefined;
      }

      if (response.ok && data?.status === 'ok' && data?.service) {
        setVerifyState({
          checked: true,
          verified: true,
          statusCode: response.status,
          payload: data,
          latencyMs,
        });
      } else {
        setVerifyState({
          checked: true,
          verified: false,
          statusCode: response.status,
          payload: data,
          latencyMs,
          error: `Backend returned HTTP ${response.status}${data?.status ? ` (status=${data.status})` : ' without valid /health JSON'}.`,
        });
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      setVerifyState({
        checked: true,
        verified: false,
        latencyMs,
        error:
          err instanceof Error
            ? `Request failed: ${err.message}. Confirm the Cloudflare Worker is deployed and reachable.`
            : 'Network error contacting /health.',
      });
    } finally {
      setVerifying(false);
    }
  }

  function handleCopyKotlin() {
    navigator.clipboard.writeText(KOTLIN_SNIPPET);
    setCopiedKotlin(true);
    setTimeout(() => setCopiedKotlin(false), 1800);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 antialiased">
      <header className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-orange-500/30 bg-orange-500/10 text-orange-400">
              <Server className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white">
                AUTOBLOGGER AI — Cloudflare Workers Backend
              </h1>
              <p className="text-xs text-slate-400">
                Workers + D1 + Queues + Cron + R2 (<code className="text-orange-400">/backend</code>) &amp; Live{' '}
                <code className="text-slate-300">GET /health</code> Verifier
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1 text-slate-300">
              <Cloud className="h-3.5 w-3.5 text-orange-400" />
              Cloudflare Free Architecture
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" />
              Not Deployed Yet (Deploy via GitHub / Dashboard)
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <nav className="mb-8 flex flex-wrap gap-2 border-b border-slate-800 pb-3">
          {[
            { id: 'verifier', label: 'Live /health Verifier', icon: Activity },
            { id: 'architecture', label: 'Workers Modules (16/16)', icon: Database },
            { id: 'bengali-guide', label: 'বাংলা Cloudflare গাইড', icon: FileText },
            { id: 'android-kotlin', label: 'Android Setup Integration', icon: Smartphone },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as TabKey)}
                className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition ${
                  active
                    ? 'bg-orange-500/15 text-orange-300 ring-1 ring-orange-500/40'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>

        {activeTab === 'verifier' && (
          <div className="grid gap-6 lg:grid-cols-5">
            <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 lg:col-span-3">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-white">
                  Verify Deployed Cloudflare Worker URL
                </h2>
                <span className="font-mono text-xs text-slate-400">GET /health</span>
              </div>
              <p className="mb-5 text-sm leading-relaxed text-slate-400">
                Enter your live Cloudflare Workers URL after deploying{' '}
                <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-200">
                  /backend
                </code>
                . This tool executes a real <code className="text-slate-300">GET /health</code>{' '}
                request and only confirms verification when the Worker returns HTTP 200 with{' '}
                <code className="text-emerald-400">status: &quot;ok&quot;</code>.
              </p>

              <form onSubmit={handleVerifyHealth} className="space-y-4">
                <div>
                  <label
                    htmlFor="worker-url"
                    className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400"
                  >
                    Cloudflare Worker URL
                  </label>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <input
                      id="worker-url"
                      type="url"
                      value={backendUrl}
                      onChange={(e) => setBackendUrl(e.target.value)}
                      placeholder="https://autoblogger-ai-backend.<subdomain>.workers.dev"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 font-mono text-sm text-white placeholder-slate-600 focus:border-orange-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={verifying}
                      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-orange-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-orange-400 disabled:opacity-60"
                    >
                      <RefreshCw className={`h-4 w-4 ${verifying ? 'animate-spin' : ''}`} />
                      {verifying ? 'Checking...' : 'Verify Backend'}
                    </button>
                  </div>
                </div>
              </form>

              {verifyState && (
                <div
                  className={`mt-6 rounded-lg border p-4 ${
                    verifyState.verified
                      ? 'border-emerald-500/40 bg-emerald-950/30'
                      : 'border-rose-500/40 bg-rose-950/30'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {verifyState.verified ? (
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p
                          className={`text-sm font-semibold ${
                            verifyState.verified ? 'text-emerald-300' : 'text-rose-300'
                          }`}
                        >
                          {verifyState.verified
                            ? 'Backend Verified Successfully'
                            : 'Verification Failed'}
                        </p>
                        {typeof verifyState.latencyMs === 'number' && (
                          <span className="font-mono text-xs text-slate-400">
                            {verifyState.latencyMs} ms
                            {verifyState.statusCode ? ` · HTTP ${verifyState.statusCode}` : ''}
                          </span>
                        )}
                      </div>

                      {verifyState.error && (
                        <p className="mt-1.5 text-xs leading-relaxed text-rose-200/90">
                          {verifyState.error}
                        </p>
                      )}

                      {verifyState.payload && (
                        <pre className="mt-3 overflow-x-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-300">
                          {JSON.stringify(verifyState.payload, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>

            <aside className="space-y-4 lg:col-span-2">
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
                  <ShieldCheck className="h-4 w-4 text-orange-400" />
                  Cloudflare Free Plan Guardrails
                </div>
                <ul className="space-y-2.5 text-xs text-slate-300">
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-orange-400" />
                    Zero Express / Node.js server deps — pure Hono + Web Standards
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-orange-400" />
                    Long AI pipelines split into 3 async Queue stages in D1
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-orange-400" />
                    Idempotency keys &amp; atomic SQL claims prevent duplicate posts
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-orange-400" />
                    Secrets managed via Cloudflare Secrets &amp; never hardcoded
                  </li>
                </ul>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
                  <Lock className="h-4 w-4 text-sky-400" />
                  Android Compatibility Note
                </div>
                <p className="text-xs leading-relaxed text-slate-400">
                  All REST paths (<code>/health</code>, <code>/api/v1/agent/*</code>,{' '}
                  <code>/api/v1/blogger/*</code>, <code>/api/v1/content/*</code>) and{' '}
                  <code>X-API-Key</code> / Firebase Bearer auth remain preserved. Drop-in verifier:{' '}
                  <code className="text-slate-200">
                    /backend/android-integration/CloudRunHealthVerifier.kt
                  </code>
                  .
                </p>
              </div>
            </aside>
          </div>
        )}

        {activeTab === 'architecture' && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-white">
                Migrated Cloudflare Workers Modules (`/backend/src`)
              </h2>
              <span className="font-mono text-xs text-orange-400">
                Workers + Hono + D1 + Queues + Cron + R2
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map((cap) => (
                <div
                  key={cap.id}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="font-mono text-xs text-orange-400">#{cap.id}</span>
                    <span className="font-mono text-[11px] text-slate-500">{cap.module}</span>
                  </div>
                  <h3 className="text-sm font-semibold text-white">{cap.name}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{cap.desc}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === 'bengali-guide' && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-white">
                Cloudflare Workers Dashboard-এর মাধ্যমে ডিপ্লয়মেন্ট গাইড
              </h2>
              <span className="font-mono text-xs text-slate-400">
                /backend/DEPLOYMENT_GUIDE_BN.md
              </span>
            </div>
            <div className="space-y-4">
              {BENGALI_STEPS.map((item) => (
                <div
                  key={item.step}
                  className="rounded-lg border border-slate-800 bg-slate-950/70 p-4"
                >
                  <h3 className="text-sm font-semibold text-orange-300">{item.step}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{item.detail}</p>
                </div>
              ))}
            </div>
            <p className="mt-5 text-xs text-slate-400">
              সম্পূর্ণ বিস্তারিত নির্দেশনা, Secrets তালিকা, GitHub Actions কনফিগারেশন এবং D1 মাইগ্রেশন
              ধাপসমূহ <code className="text-slate-200">/backend/DEPLOYMENT_GUIDE_BN.md</code> ফাইলে
              দেওয়া আছে।
            </p>
          </section>
        )}

        {activeTab === 'android-kotlin' && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">
                  Android Setup Wizard Health Verification
                </h2>
                <p className="mt-0.5 text-xs text-slate-400">
                  Full Kotlin implementation saved at{' '}
                  <code className="text-orange-400">
                    /backend/android-integration/CloudRunHealthVerifier.kt
                  </code>
                </p>
              </div>
              <button
                type="button"
                onClick={handleCopyKotlin}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                {copiedKotlin ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy Usage
                  </>
                )}
              </button>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
              <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
                <Code2 className="h-4 w-4 text-sky-400" />
                Setup Wizard Integration Example
              </div>
              <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-slate-200">
                {KOTLIN_SNIPPET}
              </pre>
            </div>

            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-300">
              <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-orange-400" />
              <p className="leading-relaxed">
                <strong>Important:</strong> Only mark the Android Setup Wizard step complete when{' '}
                <code>CloudRunHealthVerifier.verifyBackend(url)</code> returns{' '}
                <code>verified == true</code> from a live <code>GET /health</code> HTTP 200
                response. Async article pipelines return HTTP 202 with a <code>pipeline.id</code>{' '}
                that Android can poll via <code>GET /api/v1/content/pipelines/:pipelineId</code>.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
