import type { BrainType, DshConfig } from '../shared/types.js';
import type { RouterConfig } from './types.js';
import { DEFAULT_ROUTER_CONFIG } from './types.js';

export type GpuBrainConfig = NonNullable<RouterConfig['gpu']>;

import { LocalBrain } from './brains/local.js';
import { CloudBrain } from './brains/cloud.js';
import { GpuBrain } from './brains/gpu.js';
import { RunAIBrain } from './brains/runai.js';

type BrainInstance = LocalBrain | CloudBrain | GpuBrain | RunAIBrain;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MCPClient = (server: string, tool: string, args: Record<string, any>) => Promise<unknown>;

export interface BrainFactoryConfig {
  localConfig: NonNullable<RouterConfig['local']>;
  cloudConfig: NonNullable<RouterConfig['cloud']>;
  gpuConfig?: GpuBrainConfig;
  mcpClient?: MCPClient;
}

export class BrainFactory {
  private readonly _localConfig: NonNullable<RouterConfig['local']>;
  private readonly _cloudConfig: NonNullable<RouterConfig['cloud']>;
  private readonly _gpuConfig?: GpuBrainConfig;
  private readonly _mcpClient?: MCPClient;

  constructor(config: BrainFactoryConfig) {
    this._localConfig = { ...DEFAULT_ROUTER_CONFIG.local, ...config.localConfig };
    this._cloudConfig = { ...DEFAULT_ROUTER_CONFIG.cloud, ...config.cloudConfig };
    this._gpuConfig = config.gpuConfig;
    this._mcpClient = config.mcpClient;
  }

  createBrain(type: 'local'): LocalBrain | null;
  createBrain(type: 'cloud'): CloudBrain | null;
  createBrain(type: 'gpu'): GpuBrain | null;
  createBrain(type: 'runai'): RunAIBrain | null;
  createBrain(type: BrainType): BrainInstance | null;
  createBrain(type: BrainType): BrainInstance | null {
    switch (type) {
      case 'local':
        return this._createLocal();
      case 'cloud':
        return this._createCloud();
      case 'gpu':
        return this._createGpu();
      case 'nim':
        return this._createRunAI();
      default:
        return null;
    }
  }

  async createAll(): Promise<Map<BrainType, BrainInstance>> {
    const map = new Map<BrainType, BrainInstance>();
    for (const type of ['local' as const, 'cloud' as const, 'gpu' as const, 'nim' as const]) {
      const brain = this.createBrain(type);
      if (brain) {
        try {
          const available = await brain.ping();
          if (available) {
            map.set(type, brain);
          }
        } catch {
          // brain not available, skip
        }
      }
    }
    return map;
  }

  async buildFallbackChain(): Promise<BrainInstance[]> {
    const chain: BrainInstance[] = [];

    const local = this.createBrain('local');
    if (local && await local.ping()) {
      chain.push(local);
    }

    const cloud = this.createBrain('cloud');
    if (cloud && await cloud.ping()) {
      chain.push(cloud);
    }

    const gpu = this.createBrain('gpu');
    if (gpu && await gpu.ping()) {
      chain.push(gpu);
    }

    const runai = this.createBrain('runai');
    if (runai && await runai.ping()) {
      chain.push(runai);
    }

    return chain;
  }

  async selectBrain(input: string): Promise<BrainInstance | null> {
    const chain = await this.buildFallbackChain();
    if (chain.length === 0) return null;

    if (chain.length === 1) return chain[0];

    const complexity = this._assessComplexity(input);

    if (complexity === 'high') {
      for (const brain of chain) {
        if (brain instanceof GpuBrain || brain instanceof RunAIBrain) return brain;
      }
    }

    for (const brain of chain) {
      if (brain instanceof LocalBrain && complexity !== 'high') return brain;
      if (brain instanceof CloudBrain) return brain;
    }

    return chain[0] ?? null;
  }

  // --- Internal creators ---

  private _createLocal(): LocalBrain | null {
    try {
      const config = {
        enabled: this._localConfig.enabled ?? true,
        baseUrl: this._localConfig.baseUrl,
        model: this._localConfig.model,
        timeoutMs: this._localConfig.timeoutMs,
        maxRetries: this._localConfig.maxRetries,
      };
      return new LocalBrain(config);
    } catch {
      return null;
    }
  }

  private _createCloud(): CloudBrain | null {
    try {
      const config = {
        enabled: this._cloudConfig.enabled ?? true,
        gatewayUrl: this._cloudConfig.gatewayUrl,
        apiKey: this._cloudConfig.apiKey,
        models: this._cloudConfig.models,
        timeoutMs: this._cloudConfig.timeoutMs,
        maxRetries: this._cloudConfig.maxRetries,
      };
      return new CloudBrain(config);
    } catch {
      return null;
    }
  }

  private _createGpu(): GpuBrain | null {
    try {
      const hasGpuKey = !!process.env.BREV_API_KEY;
      const gpuConfig = this._gpuConfig;
      if (!hasGpuKey && !gpuConfig?.token) {
        return null;
      }
      return new GpuBrain(this._localConfig, gpuConfig);
    } catch {
      return null;
    }
  }

  private _createRunAI(): RunAIBrain | null {
    const hasCreds =
      process.env.RUNAI_BASE_URL &&
      process.env.RUNAI_CLIENT_ID &&
      process.env.RUNAI_CLIENT_SECRET;

    if (!hasCreds && !this._mcpClient) {
      return null;
    }

    return new RunAIBrain(this._localConfig, this._mcpClient);
  }

  // --- Complexity Assessment ---

  private _assessComplexity(input: string): 'low' | 'medium' | 'high' {
    const text = input.toLowerCase();
    const gpuIndicators = [
      'train', 'fine-tune', 'pre-train', 'inference', 'gpu',
      'benchmark', 'profiling', 'diffdock', 'boltz', 'genmol',
      'protein', 'molecule', 'pdb', 'smiles', 'affinity',
      'neural network', 'transformer', 'attention',
      'kubernetes', 'cluster', 'distributed',
    ];

    let score = 0;
    for (const keyword of gpuIndicators) {
      if (text.includes(keyword)) score += 1;
    }

    if (input.length > 1000) score += 2;
    if (text.includes('error') || text.includes('debug') || text.includes('troubleshoot')) score += 1;

    if (score >= 4) return 'high';
    if (score >= 2) return 'medium';
    return 'low';
  }
}
