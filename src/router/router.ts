import { readFileSync } from 'node:fs';
import type { BrainType, RoutingDecision, RoutingRequest, TaskResult } from '../shared/types.js';
import { classifyTask, createRouter, type BrainSelection, type TaskComplexity } from './types.js';
import { SelfLearningSystem } from './learning.js';
import { LocalBrain } from './brains/local.js';
import { CloudBrain } from './brains/cloud.js';
import { GpuBrain } from './brains/gpu.js';
import { NimBrain } from './brains/nim.js';
import { NimLocalBrain } from './brains/nim-local.js';
import { RunAIBrain } from './brains/runai.js';
import type { BrainBase } from './brain-base.js';
import type { RouterConfig } from './types.js';

const SCIENTIFIC_KEYWORDS = [
  'protein', 'dna', 'rna', 'genome', 'genomic', 'sequence', 'codon',
  'molecule', 'molecular', 'ligand', 'smiles', 'pdb', 'mmcif',
  'drug', 'docking', 'binding affinity', 'fold', 'folding', 'structure prediction',
  'bionemo', 'genmol', 'diffdock', 'boltz', 'openfold', 'proteinmpnn', 'evo2',
  'biomolecular', 'antibody', 'enzyme', 'peptide', 'scaffold',
];

function detectScientificTask(input: string): boolean {
  const text = input.toLowerCase();
  return SCIENTIFIC_KEYWORDS.some(k => text.includes(k));
}

/** Resolves a secret from env, then ~/.secrets/<name> (plain file). */
function resolveSecret(envName: string, fileName: string): string {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const candidates = [
    `${process.env.HOME}/.secrets/${fileName}`,
    `${process.env.HOME}/.secrets/${fileName}.env`,
  ];
  for (const path of candidates) {
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value) return value;
    } catch {
      // ignore missing secret files
    }
  }
  return '';
}

export class Router {
  private config: RouterConfig;
  private localBrain: LocalBrain;
  private cloudBrain: CloudBrain;
  private gpuBrain: GpuBrain;
  private nimBrain: NimBrain | null;
  private nimLocalBrain: NimLocalBrain | null;
  private runaiBrain: RunAIBrain;
  private learning: SelfLearningSystem;
  private selectedBrain: BrainType = 'local';
  private healthCheckHits: number = 0;
  private healthCheckFails: number = 0;

  constructor(userConfig?: Partial<RouterConfig>) {
    this.config = createRouter(userConfig);
    this.localBrain = new LocalBrain(this.config.local);
    this.cloudBrain = new CloudBrain(this.config.cloud);
    this.gpuBrain = new GpuBrain(this.config.local, this.config.gpu);
    this.runaiBrain = new RunAIBrain(this.config.local);
    this.learning = new SelfLearningSystem(this.config.selfLearning);

    const nimApiKey = this.config.nim?.apiKey
      || resolveSecret('NVIDIA_API_KEY', 'nvidia-api-key');
    const nimModels = this.config.nim?.models
      ?? (process.env.NIM_MODELS ? process.env.NIM_MODELS.split(',').map(s => s.trim()).filter(Boolean) : undefined);

    this.nimBrain = nimApiKey
      ? new NimBrain({
          apiKey: nimApiKey,
          baseUrl: this.config.nim?.baseUrl ?? process.env.NIM_BASE_URL,
          models: nimModels,
        })
      : null;

    const nimLocalEnabled = process.env.NIM_LOCAL_ENABLED === 'true';
    this.nimLocalBrain = nimApiKey && nimLocalEnabled
      ? new NimLocalBrain({
          apiKey: nimApiKey,
          portBase: this.config.nimLocal?.portBase,
          models: this.config.nimLocal?.models ?? nimModels,
        })
      : null;

    if (this.config.manualOverride.enabled && this.config.manualOverride.forceBrain) {
      this.selectedBrain = this.config.manualOverride.forceBrain;
    }
  }

  async classifyTask(input: string): Promise<TaskComplexity> {
    const { complexity } = classifyTask(input);
    return complexity;
  }

  private availableBrains(): BrainType[] {
    const brains: BrainType[] = ['local', 'cloud'];
    if (this.nimBrain) brains.push('nim');
    if (this.nimLocalBrain) brains.push('nim-local');
    if (this.config.runai?.enabled || process.env.RUNAI_BASE_URL) brains.push('runai');
    if (this.config.gpu?.enabled !== false) brains.push('gpu');
    return brains;
  }

  async decide(req: RoutingRequest): Promise<BrainSelection> {
    const { complexity, score, categories } = classifyTask(req.input);
    const scientific = detectScientificTask(req.input);

    if (this.config.manualOverride.enabled && this.config.manualOverride.forceBrain) {
      return {
        brain: this.config.manualOverride.forceBrain,
        model: this.config.manualOverride.forceModel ?? undefined,
        confidence: 1.0,
        fallbackChain: this.buildFallbackChain(this.config.manualOverride.forceBrain),
        reason: `Manual override: forceBrain=${this.config.manualOverride.forceBrain}`,
      };
    }

    // Scientific / biomedical tasks prefer NIM, then local NIM, then cloud.
    if (scientific && this.nimBrain) {
      return {
        brain: 'nim',
        confidence: 0.9,
        fallbackChain: this.buildFallbackChain('nim'),
        reason: 'Scientific task detected — routed to NVIDIA NIM brain',
      };
    }

    let selected: BrainType = 'local';
    let model: string | undefined;
    let confidence = 0.8;
    let reason = 'Default to local brain';

    const taskType = categories.length > 0 ? categories[0] : complexity;
    const bestBrainFromLearning = this.learning.getBestBrain(taskType, this.availableBrains());

    if (this.learning.shouldAdaptThresholds() && bestBrainFromLearning && bestBrainFromLearning !== 'local') {
      const successRate = this.learning.getSuccessRate(bestBrainFromLearning, taskType);
      if (successRate >= 0.85) {
        selected = bestBrainFromLearning as BrainType;
        reason = `Self-learning adaptation: ${bestBrainFromLearning} has ${(successRate * 100).toFixed(0)}% success rate for task type`;
        confidence = successRate;
      }
    }

    if (selected === 'local') {
      const localHealthy = await this.localHealthCheck();
      if (!localHealthy) {
        selected = 'cloud';
        reason = 'Local brain unhealthy — auto-upgraded to cloud';
        confidence = 0.75;
      } else if (complexity === 'high') {
        selected = 'cloud';
        model = this.config.cloud.models.primary;
        reason = `High complexity task (score: ${(score * 100).toFixed(0)}%) — routed to cloud for better capability`;
        confidence = 0.85;
      } else if (complexity === 'medium') {
        if (this.learning.shouldAdaptThresholds()) {
          const localSuccess = this.learning.getSuccessRate('local', taskType);
          if (localSuccess < 0.5) {
            selected = 'cloud';
            model = this.config.cloud.models.primary;
            reason = `Self-learning: local success rate (${(localSuccess * 100).toFixed(0)}%) below threshold`;
            confidence = localSuccess;
          }
        }
        if (!model) {
          reason = 'Medium complexity — local brain can handle';
          model = this.config.local.model;
        }
      } else {
        reason = 'Low complexity — local brain can handle';
        model = this.config.local.model;
      }
    } else if (selected === 'cloud') {
      model = this.config.cloud.models.primary;
    }

    return {
      brain: selected,
      model,
      confidence,
      fallbackChain: this.buildFallbackChain(selected),
      reason,
    };
  }

  async route(req: RoutingRequest): Promise<BrainSelection> {
    return this.decide(req);
  }

  async run(req: RoutingRequest): Promise<TaskResult> {
    const startTime = Date.now();
    const selection = await this.decide(req);
    const { brain, model } = selection;

    let result: TaskResult | null = null;
    let lastError: Error | null = null;

    const allBrains = this.buildBrainSequence(brain);

    for (let i = 0; i < allBrains.length; i++) {
      const currentBrain = allBrains[i];
      const isFallback = i > 0;

      try {
        const brainInstance = this.getBrainInstance(currentBrain);
        if (!brainInstance) {
          continue;
        }

        const brainModel = isFallback && currentBrain === 'cloud'
          ? this.config.cloud.models.fallback
          : (model ?? undefined);

        const taskResult = await this.executeWithBrain(currentBrain, req, brainModel);
        result = taskResult;

        if (isFallback) {
          this.learning.recordAutoUpgrade();
          console.info(`[Router] Auto-upgraded from ${brain} to ${currentBrain}: ${selection.reason}`);
        }

        break;
      } catch (err) {
        lastError = new Error(`Brain ${currentBrain} failed: ${this.parseError(err)}`);
        if (i < allBrains.length - 1) {
          console.debug(`[Router] ${currentBrain} failed, trying next in chain...`);
        }
      }
    }

    if (!result) {
      throw lastError ?? new Error('All brains in chain failed');
    }

    const latencyMs = Date.now() - startTime;
    const taskType = this.inferTaskType(req.input);

    this.learning.record({
      input: req.input,
      taskType,
      actualComplexity: selection.confidence > 0.7 ? 'low' : selection.confidence > 0.4 ? 'medium' : 'high',
      selectedBrain: result.brain,
      outcome: 'success',
      latencyMs,
    });

    return result;
  }

  private async executeWithBrain(brainType: BrainType, req: RoutingRequest, model?: string): Promise<TaskResult> {
    switch (brainType) {
      case 'local': {
        const brain = this.localBrain;
        return brain.execute(req);
      }
      case 'cloud': {
        const brain = this.cloudBrain;
        return brain.execute(req);
      }
      case 'gpu': {
        return this.gpuBrain.execute(req);
      }
      case 'nim': {
        if (!this.nimBrain) throw new Error('NIM brain not configured (missing NVIDIA_API_KEY)');
        return this.nimBrain.execute(req);
      }
      case 'nim-local': {
        if (!this.nimLocalBrain) throw new Error('Local NIM brain not configured (missing NVIDIA_API_KEY)');
        return this.nimLocalBrain.execute(req);
      }
      case 'runai': {
        return this.runaiBrain.execute(req);
      }
      default: {
        return this.localBrain.execute(req);
      }
    }
  }

  private buildBrainSequence(primary: BrainType): BrainType[] {
    const available = this.availableBrains();
    return this.uniq(this.rawSequence(primary))
      .filter(b => available.includes(b) && this.getBrainInstance(b) !== null);
  }

  private rawSequence(primary: BrainType): BrainType[] {
    switch (primary) {
      case 'local':
        return this.uniq(['local', 'cloud']);
      case 'cloud':
        return this.uniq(['cloud', 'local']);
      case 'nim':
        return this.uniq(['nim', 'nim-local', 'runai', 'cloud', 'local']);
      case 'nim-local':
        return this.uniq(['nim-local', 'cloud', 'local']);
      case 'runai':
        return this.uniq(['runai', 'nim', 'cloud', 'local']);
      case 'gpu':
        return this.uniq(['gpu', 'cloud', 'local']);
      default:
        return this.uniq(['local', 'cloud']);
    }
  }

  private uniq(brains: BrainType[]): BrainType[] {
    return brains.filter((b, i) => brains.indexOf(b) === i);
  }

  private buildFallbackChain(primary: BrainType): BrainType[] {
    return this.buildBrainSequence(primary);
  }

  private getBrainInstance(brainType: BrainType): BrainBase | null {
    switch (brainType) {
      case 'local': return this.localBrain;
      case 'cloud': return this.cloudBrain;
      case 'gpu': return this.gpuBrain;
      case 'nim': return this.nimBrain;
      case 'nim-local': return this.nimLocalBrain;
      case 'runai': return this.runaiBrain;
      default: return null;
    }
  }

  private parseError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return String(err);
  }

  private async localHealthCheck(): Promise<boolean> {
    try {
      const healthy = await this.localBrain.ping();
      this.healthCheckHits += 1;
      if (!healthy) this.healthCheckFails += 1;

      const failRate = this.healthCheckFails / this.healthCheckHits;
      const threshold = this.config.thresholds.localHealthThreshold;
      return failRate < (1 - threshold);
    } catch {
      this.healthCheckHits += 1;
      this.healthCheckFails += 1;
      return false;
    }
  }

  private inferTaskType(input: string): string {
    if (detectScientificTask(input)) return 'scientific';
    const { categories } = classifyTask(input);
    if (categories.length > 0) return categories[0];
    const lower = input.toLowerCase().trim();
    if (lower.startsWith('code') || lower.includes('function') || lower.includes('class')) return 'coding';
    if (lower.includes('explain') || lower.includes('why') || lower.includes('how')) return 'analysis';
    if (lower.includes('hello') || lower.includes('hi')) return 'conversation';
    if (lower.includes('search') || lower.includes('find') || lower.includes('look up')) return 'search';
    if (lower.includes('write') || lower.includes('create') || lower.includes('compose')) return 'creative';
    return 'general';
  }

  async pingAll(): Promise<Record<BrainType, boolean>> {
    const result: Record<BrainType, boolean> = {
      local: false,
      cloud: false,
      gpu: false,
      nim: false,
      'nim-local': false,
      runai: false,
    };

    await Promise.all([
      this.localBrain.ping().then(v => { result.local = v; }).catch(() => {}),
      this.cloudBrain.ping().then(v => { result.cloud = v; }).catch(() => {}),
      this.gpuBrain.ping().then(v => { result.gpu = v; }).catch(() => {}),
      this.runaiBrain.ping().then(v => { result.runai = v; }).catch(() => {}),
      this.nimBrain
        ? this.nimBrain.ping().then(v => { result.nim = v; }).catch(() => {})
        : Promise.resolve(),
      this.nimLocalBrain
        ? this.nimLocalBrain.ping().then(v => { result['nim-local'] = v; }).catch(() => {})
        : Promise.resolve(),
    ]);

    return result;
  }

  getConfig(): RouterConfig {
    return { ...this.config };
  }

  getLearningStats() {
    return this.learning.getStats();
  }

  setManualOverride(brain: BrainType | null, model?: string): void {
    this.config.manualOverride.enabled = brain !== null;
    this.config.manualOverride.forceBrain = brain;
    this.config.manualOverride.forceModel = model ?? null;
    if (brain) {
      this.selectedBrain = brain;
      this.learning.recordManualOverride();
    }
  }
}
