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
  environment?: string;
  uptimeSeconds?: number;
  timestamp?: string;
  firebaseConnected?: boolean;
  agentStatus?: string;
}

const CAPABILITIES = [
  { id: '01', name: 'GET /health Probe', module: 'routes/healthRoutes.ts', desc: 'Cloud Run liveness & Android Setup Wizard verification' },
  { id: '02', name: 'Firebase & API Key Auth', module: 'middleware/auth.ts', desc: 'Firebase ID token verifyIdToken + timing-safe X-API-Key & Scheduler secret' },
  { id: '03', name: 'Blogger API v3', module: 'services/bloggerService.ts', desc: 'OAuth2 token refresh + blog/post CRUD & draft publishing' },
  { id: '04', name: 'Multi-AI Provider Manager', module: 'services/aiProviderManager.ts', desc: 'Gemini (@google/genai), OpenRouter, API-NEX & Custom OpenAI-compatible' },
  { id: '05', name: 'Automatic AI Failover', module: 'services/aiProviderManager.ts', desc: 'Circuit breaker, cooldown tracking & Firestore provider health state' },
  { id: '06', name: 'Content Research & Gen', module: 'services/researchService.ts', desc: 'Keyword/outline research + long-form semantic Blogger HTML generation' },
  { id: '07', name: 'SEO Optimization & Schema', module: 'services/seoService.ts', desc: 'Readability, keyword density audit, AI metadata & JSON-LD Graph' },
  { id: '08', name: 'Google Search Console', module: 'services/searchConsoleService.ts', desc: 'Search Analytics queries, sitemaps & URL Indexing inspection' },
  { id: '09', name: 'Google Analytics 4', module: 'services/ga4Service.ts', desc: 'GA4 Data API v1beta reports & top-performing pages' },
  { id: '10', name: 'Autonomous Scheduler', module: 'services/schedulerService.ts', desc: 'Campaign daily quotas & Cloud Scheduler /tick orchestration' },
  { id: '11', name: 'Adsterra Ad Manager', module: 'services/adsterraService.ts', desc: 'Publisher API v3 stats + paragraph-safe HTML ad slot injection' },
  { id: '12', name: 'Persistent Task Queue', module: 'services/taskQueueService.ts', desc: 'Firestore task persistence, Cloud Tasks dispatch & exponential backoff' },
  { id: '13', name: 'FCM Push Notifications', module: 'services/fcmService.ts', desc: 'Android device token registry & topic/multicast alerts' },
  { id: '14', name: 'Daily & Weekly Analytics', module: 'workers/analyticsWorker.ts', desc: 'Aggregated GA4, GSC, Adsterra & Blogger snapshots' },
  { id: '15', name: 'Pause / Resume / E-Stop', module: 'services/agentControlService.ts', desc: 'Firestore-backed control plane cancelling pending tasks on E-Stop' },
  { id: '16', name: 'Firestore Persistence', module: 'config/firebase.ts', desc: 'Application Default Credentials (ADC) & multi-collection schema' },
  { id: '17', name: 'Structured Cloud Logging', module: 'utils/logger.ts', desc: 'Cloud Logging JSON severity format with automatic secret redaction' },
];

const KOTLIN_SNIPPET = `// Drop into your Android Setup Wizard: /backend/android-integration/CloudRunHealthVerifier.kt
val result = CloudRunHealthVerifier.verifyBackend(userEnteredUrl)
if (result.verified) {
    // Save result.normalizedBaseUrl and proceed
} else {
    // Show result.errorMessage — never accept unverified URLs
}`;

const BENGALI_STEPS = [
  {
    step: '১. GitHub রিপোজিটরি',
    detail: 'মোবাইলে github.com থেকে একটি Private repository তৈরি করে /backend ফোল্ডারের সব ফাইল (Dockerfile, package.json, tsconfig.json, src/) আপলোড করুন। .env বা আসল API Key কখনো আপলোড করবেন না।',
  },
  {
    step: '২. Google Cloud APIs চালু করুন',
    detail: 'Desktop mode-এ console.cloud.google.com খুলে Cloud Run, Cloud Build, Artifact Registry, Firestore, Cloud Scheduler, Cloud Tasks, FCM, Blogger v3, Search Console ও GA4 Data API Enable করুন।',
  },
  {
    step: '৩. Firebase & IAM কনফিগারেশন',
    detail: 'console.firebase.google.com থেকে একই GCP প্রজেক্টে Firebase ও Firestore (Production mode) চালু করুন। Cloud Run সার্ভিস অ্যাকাউন্টকে roles/datastore.user, roles/firebasecloudmessaging.admin ও roles/cloudtasks.enqueuer দিন।',
  },
  {
    step: '৪. Cloud Run-এ ডিপ্লয় করুন',
    detail: 'Cloud Run > Deploy Container > Continuously deploy from repository > GitHub সিলেক্ট করে Dockerfile দিয়ে পোর্ট 8080-এ ডিপ্লয় করুন এবং সব Environment Variables দিন।',
  },
  {
    step: '৫. Cloud Scheduler ও Android Setup Wizard',
    detail: 'ডিপ্লয়ের পর পাওয়া https://...run.app URL-টি Android Setup Wizard-এ বসান। অ্যাপটি GET /health যাচাই করে status: "ok" পেলেই সংযোগ সম্পন্ন হবে।',
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
        error: 'Enter your deployed Google Cloud Run HTTPS URL first (no fake URLs are prefilled).',
      });
      return;
    }

    if (!/^https?:\/\/.+/.test(normalized)) {
      setVerifyState({
        checked: true,
        verified: false,
        error: 'URL must start with https:// (or http:// for local testing).',
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
            ? `Request failed: ${err.message}. Confirm the Cloud Run service is deployed, allows unauthenticated /health, and has CORS enabled.`
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
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
              <Server className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white">
                AUTOBLOGGER AI — Cloud Run Backend
              </h1>
              <p className="text-xs text-slate-400">
                Production <code className="text-emerald-400">/backend</code> Service &amp; Live{' '}
                <code className="text-slate-300">GET /health</code> Verifier
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1 text-slate-300">
              <Cloud className="h-3.5 w-3.5 text-sky-400" />
              Cloud Run Ready
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" />
              Not Deployed Yet (Deploy via GitHub)
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <nav className="mb-8 flex flex-wrap gap-2 border-b border-slate-800 pb-3">
          {[
            { id: 'verifier', label: 'Live /health Verifier', icon: Activity },
            { id: 'architecture', label: 'Backend Modules (17/17)', icon: Database },
            { id: 'bengali-guide', label: 'বাংলা ডিপ্লয়মেন্ট গাইড', icon: FileText },
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
                    ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40'
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
                  Verify Deployed Cloud Run Backend URL
                </h2>
                <span className="font-mono text-xs text-slate-400">GET /health</span>
              </div>
              <p className="mb-5 text-sm leading-relaxed text-slate-400">
                Enter your live Google Cloud Run Service URL after deploying{' '}
                <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-200">
                  /backend
                </code>
                . This tool executes a real <code className="text-slate-300">GET /health</code>{' '}
                request and only confirms verification when the server returns HTTP 200 with{' '}
                <code className="text-emerald-400">status: &quot;ok&quot;</code>.
              </p>

              <form onSubmit={handleVerifyHealth} className="space-y-4">
                <div>
                  <label
                    htmlFor="cloud-run-url"
                    className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400"
                  >
                    Cloud Run Service URL
                  </label>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <input
                      id="cloud-run-url"
                      type="url"
                      value={backendUrl}
                      onChange={(e) => setBackendUrl(e.target.value)}
                      placeholder="https://autoblogger-ai-backend-xxxxxxxxxx-el.a.run.app"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 font-mono text-sm text-white placeholder-slate-600 focus:border-emerald-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={verifying}
                      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
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
                  <ShieldCheck className="h-4 w-4 text-emerald-400" />
                  Cloud Run Contract
                </div>
                <ul className="space-y-2.5 text-xs text-slate-300">
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    Listens on <code className="text-slate-200">process.env.PORT</code> (default{' '}
                    <code className="text-slate-200">8080</code>)
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    Handles <code className="text-slate-200">SIGTERM</code> /{' '}
                    <code className="text-slate-200">SIGINT</code> graceful shutdown
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    Stateless containers; state &amp; jobs persisted in Firestore
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    Secrets validated with Zod and never exposed in responses or logs
                  </li>
                </ul>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
                  <Lock className="h-4 w-4 text-sky-400" />
                  Workspace Inspection Note
                </div>
                <p className="text-xs leading-relaxed text-slate-400">
                  No existing Android project files (<code>app/</code>, <code>build.gradle</code>,{' '}
                  <code>.kt</code>) were present in this repository workspace. A drop-in Kotlin
                  verifier is ready at{' '}
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
                Implemented Backend Capabilities (`/backend/src`)
              </h2>
              <span className="font-mono text-xs text-emerald-400">
                TypeScript + Express + Firebase Admin + Cloud Tasks
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map((cap) => (
                <div
                  key={cap.id}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="font-mono text-xs text-emerald-400">#{cap.id}</span>
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
                মোবাইল ফোন ও GitHub ব্যবহার করে Google Cloud Run ডিপ্লয়মেন্ট গাইড
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
                  <h3 className="text-sm font-semibold text-emerald-300">{item.step}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{item.detail}</p>
                </div>
              ))}
            </div>
            <p className="mt-5 text-xs text-slate-400">
              সম্পূর্ণ বিস্তারিত কমান্ড, IAM Role তালিকা, Environment Variables টেবিল এবং ৪টি Cloud
              Scheduler জবের কনফিগারেশন{' '}
              <code className="text-slate-200">/backend/DEPLOYMENT_GUIDE_BN.md</code> ফাইলে সংরক্ষিত
              আছে।
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
                  <code className="text-emerald-400">
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
              <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <p className="leading-relaxed">
                <strong>Important:</strong> Never hardcode a placeholder or fake Cloud Run URL.
                Only mark the Android Setup Wizard step complete when{' '}
                <code>CloudRunHealthVerifier.verifyBackend(url)</code> returns{' '}
                <code>verified == true</code> from a live <code>GET /health</code> HTTP 200
                response.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
