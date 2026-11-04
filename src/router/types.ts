import type { BrainType, RoutingRequest, RoutingDecision, TaskResult } from '../shared/types.js';

export type TaskComplexity = 'low' | 'medium' | 'high';

export interface BrainSelection {
  brain: BrainType;
  model?: string;
  confidence: number;
  fallbackChain: BrainType[];
  reason: string;
}

export interface LearningEntry {
  timestamp: number;
  input: string;
  taskType: string;
  actualComplexity: TaskComplexity;
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
  local: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    maxRetries: number;
  };
  cloud: {
    enabled: boolean;
    gatewayUrl: string;
    apiKey: string;
    models: {
      primary: string;
      fallback: string;
      premium: string;
    };
    timeoutMs: number;
    maxRetries: number;
  };
  gpu: {
    baseUrl: string;
    token: string;
    agentPool: string;
    agentImage: string;
    enabled?: boolean;
  };
  nim?: {
    apiKey: string;
    baseUrl?: string;
    models?: string[];
  };
  nimLocal?: {
    portBase?: number;
    models?: string[];
  };
  runai?: {
    enabled: boolean;
  };
  thresholds: {
    complexityScore: {
      low: number;
      medium: number;
      high: number;
    };
    localHealthThreshold: number;
  };
  selfLearning: {
    enabled: boolean;
    learningDataPath: string;
    minSamplesBeforeAdapt: number;
    adaptationRate: number;
  };
  manualOverride: {
    enabled: boolean;
    forceBrain: BrainType | null;
    forceModel: string | null;
  };
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  local: {
    enabled: true,
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:8b',
    timeoutMs: 60000,
    maxRetries: 1,
  },
  cloud: {
    enabled: true,
    gatewayUrl: 'http://100.110.98.65/v1',
    apiKey: process.env.DSH_GATEWAY_KEY ?? '',
    models: {
      primary: 'llama-3.3-70b-instruct-fp8-fast',
      fallback: 'llama-3.3-70b-instruct-fp8-fast',
      premium: 'gpt-5.6-sol',
    },
    timeoutMs: 30000,
    maxRetries: 3,
  },
  gpu: {
    baseUrl: 'http://localhost:8000',
    token: '',
    agentPool: 'h100',
    agentImage: 'nvcr.io/nvidia/doca/doca:2.7.0',
  },
  thresholds: {
    complexityScore: {
      low: 0.3,
      medium: 0.6,
      high: 1.0,
    },
    localHealthThreshold: 0.7,
  },
  selfLearning: {
    enabled: true,
    learningDataPath: `${process.env.HOME}/.brainsait/router-learning.json`,
    minSamplesBeforeAdapt: 10,
    adaptationRate: 0.1,
  },
  manualOverride: {
    enabled: true,
    forceBrain: null,
    forceModel: null,
  },
};

const HIGH_COMPLEXITY_KEYWORDS = [
  'reason', 'analyze', 'diagnose', 'debug', 'troubleshoot',
  'architecture', 'design pattern', 'complex', 'difficult',
  'deep analysis', 'root cause', 'optimization', 'benchmark',
  'profiling', 'memory leak', 'race condition', 'concurrency',
  'distributed system', 'microservices', 'kubernetes', 'cluster',
  'security audit', 'vulnerability', 'exploit', 'cryptography',
  'transformer', 'attention mechanism', 'neural network',
  'fine-tune', 'pre-train', 'reinforcement learning',
  'multi-modal', 'computer vision', 'natural language processing',
];

const MEDIUM_COMPLEXITY_KEYWORDS = [
  'explain', 'summarize', 'compare', 'implement', 'build',
  'write', 'create', 'develop', 'refactor', 'optimize',
  'convert', 'migrate', 'integrate', 'api', 'endpoint',
  'database', 'query', 'schema', 'migration',
  'test', 'unit test', 'integration test', 'e2e',
  'deploy', 'docker', 'container', 'ci/cd', 'pipeline',
  'authentication', 'authorization', 'middleware',
  'configuration', 'environment', 'setup', 'install',
];

const LOW_COMPLEXITY_KEYWORDS = [
  'hello', 'hi', 'greet', 'thanks', 'thank you',
  'what time', 'what is', 'who is', 'when is', 'where is',
  'define', 'spell', 'translate', 'convert', 'format',
  'yes', 'no', 'ok', 'stop', 'start', 'help',
  'list', 'show', 'print', 'echo',
];

export function classifyTask(input: string): { complexity: TaskComplexity; score: number; categories: string[] } {
  const text = input.toLowerCase().trim();
  const words = text.split(/\s+/);
  const categories: string[] = [];

  let score = 0;

  for (const keyword of HIGH_COMPLEXITY_KEYWORDS) {
    if (text.includes(keyword)) {
      score += 0.15;
      categories.push(keyword);
    }
  }

  for (const keyword of MEDIUM_COMPLEXITY_KEYWORDS) {
    if (text.includes(keyword)) {
      score += 0.08;
      categories.push(keyword);
    }
  }

  for (const keyword of LOW_COMPLEXITY_KEYWORDS) {
    if (text.includes(keyword)) {
      score -= 0.05;
      categories.push(keyword);
    }
  }

  if (text.length > 500) score += 0.1;
  if (text.length > 1000) score += 0.15;
  if (text.includes('code') || text.includes('function') || text.includes('class')) score += 0.05;
  if (text.includes('error') || text.includes('bug') || text.includes('crash')) score += 0.05;
  if (words.length > 50) score += 0.05;

  score = Math.max(0, Math.min(1, score));

  const complexity: TaskComplexity = score <= 0.3 ? 'low' : score <= 0.6 ? 'medium' : 'high';

  return { complexity, score, categories };
}

function buildFallbackChain(selected: BrainType): BrainType[] {
  const chain: BrainType[] = [selected];

  if (selected === 'local') {
    chain.push('cloud');
  } else if (selected === 'cloud') {
    chain.push('local');
  } else {
    chain.push('local');
    chain.push('cloud');
  }

  return chain;
}

export function createRouter(config: Partial<RouterConfig> = {}): RouterConfig {
  return {
    local: { ...DEFAULT_ROUTER_CONFIG.local, ...(config.local ?? {}) },
    cloud: { ...DEFAULT_ROUTER_CONFIG.cloud, ...(config.cloud ?? {}) },
    gpu: { ...DEFAULT_ROUTER_CONFIG.gpu, ...(config.gpu ?? {}) },
    ...(config.nim ? { nim: config.nim } : {}),
    ...(config.nimLocal ? { nimLocal: config.nimLocal } : {}),
    ...(config.runai ? { runai: config.runai } : {}),
    thresholds: {
      complexityScore: { ...DEFAULT_ROUTER_CONFIG.thresholds.complexityScore, ...(config.thresholds?.complexityScore ?? {}) },
      localHealthThreshold: config.thresholds?.localHealthThreshold ?? DEFAULT_ROUTER_CONFIG.thresholds.localHealthThreshold,
    },
    selfLearning: { ...DEFAULT_ROUTER_CONFIG.selfLearning, ...(config.selfLearning ?? {}) },
    manualOverride: { ...DEFAULT_ROUTER_CONFIG.manualOverride, ...(config.manualOverride ?? {}) },
  };
}
