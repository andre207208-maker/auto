export type AIProviderName = 'gemini' | 'openrouter' | 'apinex' | 'custom';

export type AgentStatus = 'running' | 'paused' | 'stopped';

export interface AgentControlState {
  status: AgentStatus;
  emergencyStop: boolean;
  reason?: string;
  updatedBy?: string;
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
  lastError?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  averageLatencyMs?: number;
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
  | 'GENERATE_AND_PUBLISH'
  | 'RESEARCH_TOPIC'
  | 'SYNC_ANALYTICS_DAILY'
  | 'SYNC_ANALYTICS_WEEKLY'
  | 'SEND_NOTIFICATION'
  | 'INDEX_URL_CHECK';

export type TaskStatus = 'queued' | 'processing' | 'retrying' | 'completed' | 'dead_letter' | 'cancelled';

export interface PersistentTask<T = Record<string, unknown>> {
  id: string;
  type: TaskType;
  payload: T;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  result?: Record<string, unknown> | null;
  cloudTaskName?: string | null;
  createdBy: string;
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
  authMethod: 'firebase_id_token' | 'api_key' | 'cloud_scheduler';
  roles: string[];
}
