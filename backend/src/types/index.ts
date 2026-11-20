export type AIProviderName = 'gemini' | 'openrouter' | 'apinex' | 'custom';

export type AgentStatus = 'running' | 'paused' | 'stopped';

export interface QueueTaskMessage {
  taskId: string;
  type: TaskType;
  enqueuedAt: string;
}

export interface WorkerEnv {
  // Cloudflare Bindings
  DB: D1Database;
  TASK_QUEUE?: Queue<QueueTaskMessage>;
  MEDIA_BUCKET?: R2Bucket;

  // Non-secret vars (wrangler.jsonc)
  SERVICE_NAME?: string;
  ENVIRONMENT?: string;
  ALLOW_API_KEY_AUTH?: string;
  CORS_ALLOWED_ORIGINS?: string;
  AI_PROVIDER_ORDER?: string;
  AI_CIRCUIT_BREAKER_THRESHOLD?: string;
  AI_CIRCUIT_BREAKER_COOLDOWN_MS?: string;
  GEMINI_MODEL?: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_NAME?: string;
  APINEX_BASE_URL?: string;
  APINEX_MODEL?: string;
  TAVILY_BASE_URL?: string;
  ADSTERRA_BASE_URL?: string;

  // Cloudflare Secrets
  BACKEND_API_SECRET?: string;
  SCHEDULER_SHARED_SECRET?: string;
  FIREBASE_PROJECT_ID?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  APINEX_API_KEY?: string;
  CUSTOM_AI_API_KEY?: string;
  CUSTOM_AI_BASE_URL?: string;
  CUSTOM_AI_MODEL?: string;
  TAVILY_API_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REFRESH_TOKEN?: string;
  DEFAULT_BLOGGER_BLOG_ID?: string;
  GSC_SITE_URL?: string;
  GA4_PROPERTY_ID?: string;
  ADSTERRA_API_KEY?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
}

export interface AgentControlState {
  status: AgentStatus;
  emergencyStop: boolean;
  reason?: string | null;
  updatedBy?: string | null;
  updatedAt: string;
}

export interface AIGenerationRequest {
  prompt: string;
  systemInstruction?: string;
  preferredProvider?: AIProviderName;
  model?: string;
  jsonMode?: boolean;
  maxTokens?: number;
}

export interface AIGenerationResponse {
  text: string;
  provider: AIProviderName;
  model: string;
  latencyMs: number;
  attempts: Array<{
    provider: AIProviderName;
    success: boolean;
    error?: string;
    latencyMs: number;
  }>;
}

export interface AIProviderHealth {
  provider: AIProviderName;
  configured: boolean;
  healthy: boolean;
  consecutiveFailures: number;
  circuitOpenUntil: number | null;
  lastError?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  averageLatencyMs?: number | null;
}

export interface TavilySearchSource {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface ResearchTopicResult {
  niche: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  searchIntent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  suggestedTitles: string[];
  outline: Array<{
    heading: string;
    subheadings: string[];
    keyPoints: string[];
  }>;
  faqQuestions: string[];
  estimatedDifficulty: 'low' | 'medium' | 'high';
  providerUsed: AIProviderName;
  tavilySources?: TavilySearchSource[];
}

export interface GeneratedArticle {
  title: string;
  slug: string;
  metaDescription: string;
  labels: string[];
  htmlContent: string;
  plainExcerpt: string;
  wordCount: number;
  faqItems: Array<{ question: string; answer: string }>;
  imagePrompts: string[];
  providerUsed: AIProviderName;
  modelUsed: string;
}

export interface SEOAuditResult {
  score: number;
  titleLength: number;
  metaDescriptionLength: number;
  wordCount: number;
  keywordDensityPercent: number;
  h1Count: number;
  h2Count: number;
  hasFaqSchema: boolean;
  issues: string[];
  recommendations: string[];
  optimizedMetaTitle: string;
  optimizedMetaDescription: string;
  optimizedSlug: string;
  jsonLdSchema: Record<string, unknown>;
}

export type TaskType =
  | 'PIPELINE_RESEARCH'
  | 'PIPELINE_GENERATE'
  | 'PIPELINE_OPTIMIZE_AND_PUBLISH'
  | 'GENERATE_AND_PUBLISH'
  | 'RESEARCH_TOPIC'
  | 'GENERATE_ARTICLE'
  | 'SYNC_ANALYTICS_DAILY'
  | 'SYNC_ANALYTICS_WEEKLY'
  | 'SEND_NOTIFICATION'
  | 'INDEX_URL_CHECK';

export type TaskStatus =
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'completed'
  | 'dead_letter'
  | 'cancelled';

export interface PersistentTask<T = Record<string, unknown>> {
  id: string;
  idempotencyKey?: string | null;
  type: TaskType;
  payload: T;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  result?: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export type PipelineStage =
  | 'research_queued'
  | 'research_done'
  | 'generate_queued'
  | 'generate_done'
  | 'publish_queued'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PipelineRun {
  id: string;
  campaignId?: string | null;
  stage: PipelineStage;
  niche: string;
  seedKeyword?: string | null;
  blogId?: string | null;
  language: string;
  tone?: string | null;
  publishAsDraft: boolean;
  injectAds: boolean;
  preferredProvider?: AIProviderName | null;
  research?: ResearchTopicResult | null;
  article?: GeneratedArticle | null;
  seo?: SEOAuditResult | null;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  triggeredBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface CampaignSchedule {
  id: string;
  name: string;
  niche: string;
  blogId: string;
  enabled: boolean;
  cronExpression: string;
  postsPerDay: number;
  publishAsDraft: boolean;
  injectAds: boolean;
  preferredProvider?: AIProviderName;
  language: string;
  targetKeywords: string[];
  lastRunAt?: string | null;
  postsPublishedToday: number;
  lastResetDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdsterraPlacementConfig {
  id: string;
  name: string;
  placementType: 'top_banner' | 'mid_article' | 'bottom_banner' | 'social_bar' | 'native_banner';
  scriptHtml: string;
  enabled: boolean;
  insertAfterParagraph?: number;
  updatedAt: string;
}

export interface AuthenticatedPrincipal {
  uid: string;
  email?: string;
  authMethod: 'firebase_id_token' | 'api_key' | 'scheduler_secret';
  roles: string[];
}
