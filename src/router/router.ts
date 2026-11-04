import type { BrainType, RoutingDecision, RoutingRequest, TaskResult } from '../shared/types.js';
import { classifyTask, createRouter, type BrainSelection, type TaskComplexity } from './types.js';
import { SelfLearningSystem } from './learning.js';
import { LocalBrain } from './brains/local.js';
import { CloudBrain } from './brains/cloud.js';
import type { RouterConfig } from './types.js';

export class Router {
  private config: RouterConfig;
  private localBrain: LocalBrain;
  private cloudBrain: CloudBrain;
  private learning: SelfLearningSystem;
  private selectedBrain: BrainType = 'local';
  private healthCheckHits: number = 0;
  private healthCheckFails: number = 0;

  constructor(userConfig?: Partial<RouterConfig>) {
    this.config = createRouter(userConfig);
    this.localBrain = new LocalBrain(this.config.local);
    this.cloudBrain = new CloudBrain(this.config.cloud);
    this.learning = new SelfLearningSystem(this.config.selfLearning);

    if (this.config.manualOverride.enabled && this.config.manualOverride.forceBrain) {
      this.selectedBrain = this.config.manualOverride.forceBrain;
    }
  }

  async classifyTask(input: string): Promise<TaskComplexity> {
    const { complexity } = classifyTask(input);
    return complexity;
  }

  async decide(req: RoutingRequest): Promise<BrainSelection> {
    const { complexity, score, categories } = classifyTask(req.input);

    if (this.config.manualOverride.enabled && this.config.manualOverride.forceBrain) {
      return {
        brain: this.config.manualOverride.forceBrain,
        model: this.config.manualOverride.forceModel ?? undefined,
        confidence: 1.0,
        fallbackChain: this.buildFallbackChain(this.config.manualOverride.forceBrain),
        reason: `Manual override: forceBrain=${this.config.manualOverride.forceBrain}`,
      };
    }

    let selected: BrainType = 'local';
    let model: string | undefined;
    let confidence = 0.8;
    let reason = 'Default to local brain';

    const taskType = categories.length > 0 ? categories[0] : complexity;
    const bestBrainFromLearning = this.learning.getBestBrain(taskType, ['local', 'cloud']);

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
      const latencyMs = Date.now() - startTime;
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
      default: {
        const brain = this.localBrain;
        return brain.execute(req);
      }
    }
  }

  private buildBrainSequence(primary: BrainType): BrainType[] {
    if (primary === 'local') return ['local', 'cloud'];
    if (primary === 'cloud') return ['cloud', 'local'];
    return ['local', 'cloud'];
  }

  private buildFallbackChain(primary: BrainType): BrainType[] {
    return this.buildBrainSequence(primary);
  }

  private getBrainInstance(brainType: BrainType): BrainBase | null {
    switch (brainType) {
      case 'local': return this.localBrain;
      case 'cloud': return this.cloudBrain;
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
    const local = await this.localBrain.ping();
    const cloud = await this.cloudBrain.ping();
    return { local, cloud };
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
