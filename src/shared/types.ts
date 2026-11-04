export interface BrainConfig {
  type: 'local' | 'cloud' | 'gpu' | 'nim';
  enabled: boolean;
  model?: string;
  options?: Record<string, unknown>;
}

export interface DshConfig {
  dshGateway: string;
  dshKey: string;
  ollama: {
    baseUrl: string;
    model: string;
  };
  cloud: {
    gatewayUrl: string;
    apiKey: string;
  };
  gpu: {
    baseUrl: string;
    token: string;
    agentPool: string;
    agentImage: string;
  };
  nim: {
    baseUrl: string;
    apiKey: string;
  };
}

export type BrainType = 'local' | 'cloud' | 'gpu' | 'nim' | 'nim-local' | 'runai';

export interface RoutingRequest {
  input: string;
  context?: unknown;
}

export interface RoutingDecision {
  brain: BrainType;
  model?: string;
  confidence: number;
}

export interface TaskResult {
  brain: BrainType;
  model?: string;
  output: string;
  tokensUsed?: number;
  latencyMs?: number;
}

export interface LarkConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
}

export interface SuperagentConfig {
  dsh: DshConfig;
  lark: LarkConfig;
  port: number;
  logLevel: string;
}
