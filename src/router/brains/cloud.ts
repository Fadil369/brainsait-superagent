import type { RoutingDecision, RoutingRequest, TaskResult } from '../../shared/types.js';
import { BrainBase } from '../brain-base.js';
import type { RouterConfig } from '../types.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string; finish_reason: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIModelsResponse {
  object: string;
  data: Array<{ id: string; created: number; object: string; owned_by: string }>;
}

export class CloudBrain extends BrainBase {
  readonly name: 'cloud' = 'cloud';
  private gatewayUrl: string;
  private apiBase: string;
  private apiKey: string;
  private models: string[];
  private modelIndex: number;

  constructor(config: RouterConfig['cloud']) {
    super(config.timeoutMs, config.maxRetries);
    const base = config.gatewayUrl.replace(/\/+$/, '');
    if (config.apiBase !== undefined) {
      this.gatewayUrl = base;
      this.apiBase = config.apiBase.replace(/\/+$/, '');
    } else if (base.endsWith('/v1')) {
      this.gatewayUrl = base.slice(0, -3);
      this.apiBase = '/v1';
    } else {
      this.gatewayUrl = base;
      this.apiBase = '/v1';
    }
    this.apiKey = config.apiKey;
    this.models = [
      config.models.primary,
      config.models.fallback,
      config.models.premium,
    ].filter(Boolean);
    this.modelIndex = 0;
  }

  private getNextModel(): string {
    if (this.models.length === 0) throw new Error('No cloud models configured');
    const model = this.models[this.modelIndex % this.models.length];
    this.modelIndex += 1;
    return model;
  }

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async chat(model: string, messages: ChatMessage[]): Promise<OpenAIChatResponse> {
    const body: OpenAIChatRequest = {
      model,
      messages,
      stream: false,
      temperature: 0.7,
      max_tokens: 8192,
    };

    const headers = this.buildHeaders(this.buildAuthHeaders());
    const res = await this.fetchJson(`${this.gatewayUrl}${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return res.json() as Promise<OpenAIChatResponse>;
  }

  async execute(req: RoutingRequest): Promise<TaskResult> {
    const startTime = Date.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant. Be concise and accurate.' },
      { role: 'user', content: req.input },
    ];

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.models.length && !lastError; attempt++) {
      const model = this.models[attempt];
      try {
        const response = await this.withTimeout(this.chat(model, messages));
        const choice = response.choices?.[0]?.message as
          | { content?: string | null; reasoning?: string | null }
          | undefined;
        const output = choice?.content || choice?.reasoning || '';
        const latencyMs = Date.now() - startTime;
        const tokensUsed = response.usage?.total_tokens;

        return {
          brain: 'cloud',
          model,
          output,
          tokensUsed,
          latencyMs,
        };
      } catch (err) {
        lastError = new Error(`Model ${model} failed: ${this.parseError(err)}`);
      }
    }

    throw lastError ?? new Error('All cloud models failed');
  }

  async route(req: RoutingRequest): Promise<RoutingDecision> {
    const model = this.models[0] ?? '';
    return {
      brain: 'cloud',
      model,
      confidence: 0.9,
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const headers = this.buildHeaders(this.buildAuthHeaders());
      const res = await this.withTimeout(
        this.fetchJson(`${this.gatewayUrl}${this.apiBase}/models`, { method: 'GET', headers }),
      );
      const data = await res.json() as OpenAIModelsResponse;
      return data.data?.map(m => m.id) ?? [];
    } catch {
      return this.models;
    }
  }

  private pingCache: { at: number; ok: boolean } | null = null;

  async ping(): Promise<boolean> {
    if (this.pingCache && Date.now() - this.pingCache.at < 5 * 60_000) {
      return this.pingCache.ok;
    }
    try {
      const headers = this.buildHeaders(this.buildAuthHeaders());
      const model = this.models[0];
      if (!model) {
        this.pingCache = { at: Date.now(), ok: false };
        return false;
      }
      // /models is often public while /chat/completions is gated, so probe a real completion.
      const res = await this.withTimeout(
        this.fetchJson(`${this.gatewayUrl}${this.apiBase}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          }),
        }),
        20000,
      );
      const contentType = res.headers.get('content-type') ?? '';
      const ok = res.ok && contentType.includes('application/json');
      this.pingCache = { at: Date.now(), ok };
      return ok;
    } catch {
      this.pingCache = { at: Date.now(), ok: false };
      return false;
    }
  }
}
