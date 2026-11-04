const BASE = '/api';

// ── Type definitions ────────────────────────────────────────────────────────

export type BrainType = 'local' | 'cloud' | 'gpu' | 'nim';

export interface LearningEntry {
  timestamp: number;
  input: string;
  taskType: string;
  actualComplexity: 'low' | 'medium' | 'high';
  selectedBrain: BrainType;
  outcome: 'success' | 'failure';
  latencyMs: number;
  errorMessage?: string;
}

export interface LearningStats {
  version: number;
  lastUpdated: number;
  entries: LearningEntry[];
  perBrainPerType: Record<string, { total: number; success: number; failure: number; avgLatencyMs: number }>;
  autoUpgrades: number;
  manualOverrides: number;
}

export interface RouterConfig {
  local: { enabled: boolean; baseUrl: string; model: string; timeoutMs: number; maxRetries: number };
  cloud: { enabled: boolean; gatewayUrl: string; apiKey: string; models: { primary: string; fallback: string; premium: string }; timeoutMs: number; maxRetries: number };
  thresholds: { complexityScore: { low: number; medium: number; high: number }; localHealthThreshold: number };
  selfLearning: { enabled: boolean; learningDataPath: string; minSamplesBeforeAdapt: number; adaptationRate: number };
  manualOverride: { enabled: boolean; forceBrain: BrainType | null; forceModel: string | null };
}

export interface Ticket {
  id: string;
  subject: string;
  description: string;
  status: 'open' | 'resolved' | 'escalated' | 'in-progress';
  brain: BrainType;
  confidence: number;
  routerOutput: string;
  tokensUsed?: number;
  latencyMs?: number;
  timestamp: string;
}

export interface ActivityEntry {
  id: string;
  timestamp: string;
  status: 'success' | 'error' | 'warning' | 'info';
  type: string;
  message: string;
}

export interface DshConfig {
  dsh: { dshGateway: string; dshKey: string; ollama: { baseUrl: string; model: string }; cloud: { gatewayUrl: string; apiKey: string }; gpu: { baseUrl: string; token: string; agentPool: string; agentImage: string }; nim: { baseUrl: string; apiKey: string } };
  lark: { appId: string; appSecret: string; verificationToken: string };
  port: number;
  logLevel: string;
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

// Health check
export async function getHealth() {
  return fetchJson<{
    agentRunning: boolean;
    activeBrain: string;
    local: boolean;
    cloud: boolean;
    gpu?: boolean;
    nim?: boolean;
    uptime?: string;
  }>('/health');
}

// Learning stats
export async function getLearningStats(): Promise<LearningStats> {
  return fetchJson<LearningStats>('/learning-stats');
}

// Router config
export async function getRouterConfig(): Promise<RouterConfig> {
  return fetchJson<RouterConfig>('/router-config');
}

// Manual override
export async function setManualOverride(brain: string | null) {
  return fetchJson<{ success: boolean; brain: string | null }>('/router/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brain }),
  });
}

// Tickets
export async function getTickets(limit = 50): Promise<Ticket[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  return fetchJson<Ticket[]>(`/tickets?${params}`);
}

export async function getTicketDetails(id: string): Promise<Ticket> {
  return fetchJson<Ticket>(`/tickets/${encodeURIComponent(id)}`);
}

export async function resolveTicket(id: string) {
  return fetchJson<{ success: boolean }>('/tickets/' + encodeURIComponent(id) + '/resolve', {
    method: 'POST',
  });
}

// Activity log
export async function getActivityLog(limit = 100): Promise<ActivityEntry[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  return fetchJson<ActivityEntry[]>(`/activity?${params}`);
}

// Config
export async function getConfig(): Promise<DshConfig> {
  return fetchJson<DshConfig>('/config');
}
