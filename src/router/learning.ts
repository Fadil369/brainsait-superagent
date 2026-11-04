import fs from 'node:fs';
import path from 'node:path';
import {
  type TaskComplexity,
  type LearningEntry,
  type LearningStats,
  type RouterConfig,
  DEFAULT_ROUTER_CONFIG,
} from './types.js';

export class SelfLearningSystem {
  private learningDataPath: string;
  private minSamplesBeforeAdapt: number;
  private adaptationRate: number;
  private enabled: boolean;
  private stats: LearningStats;
  private lock: Promise<void> = Promise.resolve();

  constructor(config?: Partial<RouterConfig['selfLearning']>) {
    const cfg = { ...DEFAULT_ROUTER_CONFIG.selfLearning, ...config };
    this.enabled = cfg.enabled;
    this.learningDataPath = cfg.learningDataPath;
    this.minSamplesBeforeAdapt = cfg.minSamplesBeforeAdapt;
    this.adaptationRate = cfg.adaptationRate;

    this.stats = this.loadStats();
  }

  private loadStats(): LearningStats {
    try {
      const dir = path.dirname(this.learningDataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.learningDataPath)) {
        const raw = fs.readFileSync(this.learningDataPath, 'utf-8');
        return JSON.parse(raw) as LearningStats;
      }
    } catch {
      // corrupt or unreadable file — start fresh
    }

    return {
      version: 1,
      lastUpdated: Date.now(),
      entries: [],
      perBrainPerType: {},
      autoUpgrades: 0,
      manualOverrides: 0,
    };
  }

  private saveStats(): void {
    try {
      const dir = path.dirname(this.learningDataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.stats.lastUpdated = Date.now();
      fs.writeFileSync(this.learningDataPath, JSON.stringify(this.stats, null, 2), 'utf-8');
    } catch (err) {
      console.error('[SelfLearning] Failed to persist learning data:', err);
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolveNext: () => void;
    const next = new Promise<void>(r => { resolveNext = r; });
    const current = this.lock;
    this.lock = next;
    await current;
    try {
      return await fn();
    } finally {
      resolveNext!();
    }
  }

  record(entry: Omit<LearningEntry, 'timestamp'>): void {
    if (!this.enabled) return;

    this.withLock(() => {
      const fullEntry: LearningEntry = { ...entry, timestamp: Date.now() };
      this.stats.entries.push(fullEntry);

      const key = `${entry.selectedBrain}:${entry.taskType}`;
      if (!this.stats.perBrainPerType[key]) {
        this.stats.perBrainPerType[key] = { total: 0, success: 0, failure: 0, avgLatencyMs: 0 };
      }
      const bucket = this.stats.perBrainPerType[key];
      bucket.total += 1;
      if (entry.outcome === 'success') bucket.success += 1;
      else bucket.failure += 1;
      bucket.avgLatencyMs = bucket.avgLatencyMs * (1 - this.adaptationRate) + entry.latencyMs * this.adaptationRate;
      bucket.avgLatencyMs = Math.round(bucket.avgLatencyMs * 100) / 100;

      this.saveStats();
      return Promise.resolve();
    });
  }

  getSuccessRate(brain: string, taskType: string): number {
    const key = `${brain}:${taskType}`;
    const bucket = this.stats.perBrainPerType[key];
    if (!bucket || bucket.total < 2) return 0.5;
    return bucket.success / bucket.total;
  }

  getAvgLatency(brain: string, taskType: string): number {
    const key = `${brain}:${taskType}`;
    const bucket = this.stats.perBrainPerType[key];
    if (!bucket) return 0;
    return bucket.avgLatencyMs;
  }

  getBestBrain(taskType: string, candidates: string[]): string | null {
    if (!this.enabled) return null;

    let bestBrain: string | null = null;
    let bestScore = -Infinity;

    for (const brain of candidates) {
      const rate = this.getSuccessRate(brain, taskType);
      const latency = this.getAvgLatency(brain, taskType);
      const latencyPenalty = latency > 0 ? Math.min(latency / 10000, 0.2) : 0;
      const score = rate - latencyPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestBrain = brain;
      }
    }

    return bestBrain;
  }

  shouldAdaptThresholds(): boolean {
    if (!this.enabled) return false;
    let totalEntries = 0;
    for (const key of Object.keys(this.stats.perBrainPerType)) {
      totalEntries += this.stats.perBrainPerType[key].total;
    }
    return totalEntries >= this.minSamplesBeforeAdapt;
  }

  recordAutoUpgrade(): void {
    if (!this.enabled) return;
    this.withLock(() => {
      this.stats.autoUpgrades += 1;
      this.saveStats();
      return Promise.resolve();
    });
  }

  recordManualOverride(): void {
    if (!this.enabled) return;
    this.withLock(() => {
      this.stats.manualOverrides += 1;
      this.saveStats();
      return Promise.resolve();
    });
  }

  getStats(): LearningStats {
    return { ...this.stats };
  }

  reset(): void {
    this.withLock(() => {
      this.stats = {
        version: this.stats.version + 1,
        lastUpdated: Date.now(),
        entries: [],
        perBrainPerType: {},
        autoUpgrades: this.stats.autoUpgrades,
        manualOverrides: this.stats.manualOverrides,
      };
      this.saveStats();
      return Promise.resolve();
    });
  }

  getEntries(limit = 100): LearningEntry[] {
    return this.stats.entries.slice(-limit);
  }
}
