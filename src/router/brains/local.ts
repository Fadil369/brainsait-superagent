import type { RoutingDecision, RoutingRequest, TaskResult } from '../shared/types.js';
import { BrainBase } from '../router/brain-base.js';
import type { RouterConfig, TaskComplexity } from '../router/types.js';
import { classifyTask } from '../router/types.js';

interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  stream?: boolean;
  options?: Record<string, unknown>;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
}

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
}

interface OllamaGenerateResponse {
  response: string;
  model: string;
  done: boolean;
}

interface OllamaClassifyRequest {
  model: string;
  prompt: string;
  system?: string;
  stream?: boolean;
}

export class LocalBrain extends BrainBase {
  readonly name: 'local' = 'local';
  private baseUrl: string;
  private model: string;

  constructor(config: RouterConfig['local']) {
    super(config.timeoutMs, config.maxRetries);
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.model = config.model;
  }

  private async post<TReq, TRes>(
    endpoint: string,
    body: TReq,
  ): Promise<TRes> {
    const res = await this.fetchJson(
      `${this.baseUrl}${endpoint}`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
    );
    return res.json() as Promise<TRes>;
  }

  async execute(req: RoutingRequest): Promise<TaskResult> {
    const startTime = Date.now();

    const messages: OllamaChatRequest['messages'] = [
      { role: 'system', content: 'You are a helpful assistant powered by a local LLM. Be concise and accurate.' },
      { role: 'user', content: req.input },
    ];

    const response = await this.withTimeout(
      this.post<OllamaChatRequest, OllamaChatResponse>(
        '/api/chat',
        { model: this.model, messages },
      ),
    );

    const output = response.message?.content ?? response.message?.role ?? '';
    const latencyMs = Date.now() - startTime;

    return {
      brain: 'local',
      output,
      latencyMs,
    };
  }

  async route(req: RoutingRequest): Promise<RoutingDecision> {
    const { complexity } = classifyTask(req.input);
    const confidence = complexity === 'low' ? 0.95 : complexity === 'medium' ? 0.85 : 0.7;

    return {
      brain: 'local',
      model: this.model,
      confidence,
    };
  }

  async classify(input: string): Promise<{ category: string; confidence: number }> {
    const prompt = `Classify the following request into one of these categories: coding, analysis, conversation, search, creative, technical, math, other.

Request: ${input}

Return only the category name and a confidence score between 0 and 1, separated by a comma. Example: coding,0.9`;

    const messages: OllamaChatRequest['messages'] = [
      { role: 'system', content: 'You are a task classifier. Return only the category and confidence score.' },
      { role: 'user', content: prompt },
    ];

    const response = await this.withTimeout(
      this.post<OllamaChatRequest, OllamaChatResponse>(
        '/api/chat',
        { model: this.model, messages },
      ),
    );

    const text = response.message?.content ?? '';
    const parts = text.split(',');
    const category = parts[0]?.trim() ?? 'other';
    const confidence = parseFloat(parts[1]?.trim() ?? '0.5');

    return { category, confidence: isNaN(confidence) ? 0.5 : Math.min(1, Math.max(0, confidence)) };
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.withTimeout(
      this.post<OllamaGenerateRequest, OllamaGenerateResponse>(
        '/api/generate',
        { model: this.model, prompt, stream: false },
      ),
    );

    return response.response;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchJson(`${this.baseUrl}/api/tags`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }
}
