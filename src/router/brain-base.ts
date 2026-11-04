import type {
  BrainType,
  RoutingDecision,
  RoutingRequest,
  TaskResult,
} from '../shared/types.js';

export abstract class BrainBase {
  abstract readonly name: BrainType;
  protected timeoutMs: number;
  protected maxRetries: number;

  constructor(timeoutMs = 15000, maxRetries = 2) {
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
  }

  abstract execute(req: RoutingRequest): Promise<TaskResult>;
  abstract route(req: RoutingRequest): Promise<RoutingDecision>;
  abstract ping(): Promise<boolean>;

  protected withTimeout<T>(promise: Promise<T>, ms?: number): Promise<T> {
    const timeout = ms ?? this.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Brain ${this.name} timed out after ${timeout}ms`));
      }, timeout);
      promise
        .then(result => { clearTimeout(timer); resolve(result); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  protected withRetry<T>(fn: () => Promise<T>, retries?: number): Promise<T> {
    const attempts = retries ?? this.maxRetries;
    return this._doRetry(fn, attempts);
  }

  private async _doRetry<T>(fn: () => Promise<T>, remaining: number): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (remaining <= 0) throw err;
      const delayMs = Math.pow(2, Math.max(0, this.maxRetries - remaining)) * 300;
      await new Promise(r => setTimeout(r, delayMs));
      return this._doRetry(fn, remaining - 1);
    }
  }

  protected parseError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return String(err);
  }

  protected async fetchJson(url: string, options: RequestInit, retries?: number): Promise<Response> {
    return this.withRetry(async () => {
      const response = await this.withTimeout(fetch(url, options));
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${body.substring(0, 200)}`);
      }
      return response;
    }, retries);
  }

  protected buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...extra,
    };
  }
}
