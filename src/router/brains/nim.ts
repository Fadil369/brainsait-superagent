import type { RoutingDecision, RoutingRequest, TaskResult } from '../../shared/types.js';
import { BrainBase } from '../brain-base.js';
import type { RouterConfig } from '../types.js';

// ---------------------------------------------------------------------------
// NIM model registry
// ---------------------------------------------------------------------------

export interface NimModel {
  id: string;
  name: string;
  category: 'drug-discovery' | 'protein' | 'genomics';
  endpoint: string;
  description: string;
}

export const NIM_MODELS: NimModel[] = [
  {
    id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
    name: 'Nemotron Ultra 253B',
    category: 'drug-discovery',
    endpoint: '/chat/completions',
    description: 'Frontier scientific reasoning for molecular and drug-discovery tasks',
  },
  {
    id: 'nvidia/llama-3.1-nemotron-70b-instruct',
    name: 'Nemotron 70B',
    category: 'protein',
    endpoint: '/chat/completions',
    description: 'Protein, structural biology and general scientific analysis',
  },
  {
    id: 'deepseek-ai/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    category: 'genomics',
    endpoint: '/chat/completions',
    description: 'Fast genomics and sequence analysis reasoning',
  },
];

// ---------------------------------------------------------------------------
// API request / response types (NVIDIA NIM OpenAI-compatible subset)
// ---------------------------------------------------------------------------

interface NIMChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

interface NIMChatChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

interface NIMChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface NIMChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: NIMChatChoice[];
  usage?: NIMChatUsage;
}

// BioNeMo / generation-specific response envelope
interface NIMGenerationResponse {
  outputs: Array<{
    generated_text?: string;
    results?: Array<{
      generated_text?: string;
      generated_tokens?: number;
      finish_reason?: string;
      seed?: number;
      input_text?: string;
    }>;
    errors?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NimBrainConfig {
  apiKey: string;
  baseUrl?: string;
  models?: string[]; // comma-separated model IDs from NIM_MODELS; empty = all
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

// ---------------------------------------------------------------------------
// NIMBrain — cloud NVIDIA NIM microservice
// ---------------------------------------------------------------------------

export class NimBrain extends BrainBase {
  readonly name: 'nim' = 'nim';
  private baseUrl: string;
  private apiKey: string;
  private models: NimModel[];
  private _modelIds: string[];
  private modelIndex: number;
  private pingCache: { at: number; ok: boolean } | null = null;

  constructor(config: NimBrainConfig) {
    super(config.timeoutMs ?? 30000, config.maxRetries ?? 3);
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.modelIndex = 0;

    const selected = config.models;
    if (selected && selected.length > 0) {
      this.models = selected.map(id => NIM_MODELS.find(m => m.id === id) ?? {
        id,
        name: id,
        category: 'protein' as const,
        endpoint: '/chat/completions',
        description: id,
      });
    } else {
      this.models = [...NIM_MODELS];
    }
    this._modelIds = this.models.map(m => m.id);
  }

  // -- model selection -------------------------------------------------------

  private pickModel(): NimModel {
    if (this.models.length === 0) {
      throw new Error('No NIM models configured');
    }
    const model = this.models[this.modelIndex % this.models.length];
    this.modelIndex += 1;
    return model;
  }

  private availableModelIds(): string[] {
    return this._modelIds;
  }

  // -- HTTP helpers ----------------------------------------------------------

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async postChat(model: string, messages: NIMChatRequest['messages']): Promise<NIMChatResponse> {
    const res = await this.withTimeout(
      fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(this.authHeaders()),
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          temperature: 0.3,
          max_tokens: 8192,
        } as NIMChatRequest),
      }),
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Handle rate limiting explicitly
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;
        await new Promise(r => setTimeout(r, delay));
        return this.postChat(model, messages); // retry via caller
      }
      throw new Error(`NIM HTTP ${res.status}: ${body.substring(0, 500)}`);
    }

    return (await res.json()) as Promise<NIMChatResponse>;
  }

  private async postGeneration(model: string, messages: NIMChatRequest['messages']): Promise<NIMGenerationResponse> {
    const res = await this.withTimeout(
      fetch(`${this.baseUrl}/generation`, {
        method: 'POST',
        headers: this.buildHeaders(this.authHeaders()),
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          temperature: 0.2,
          max_tokens: 4096,
        } as NIMChatRequest),
      }),
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;
        await new Promise(r => setTimeout(r, delay));
        return this.postGeneration(model, messages);
      }
      throw new Error(`NIM generation HTTP ${res.status}: ${body.substring(0, 500)}`);
    }

    return (await res.json()) as Promise<NIMGenerationResponse>;
  }

  // -- task routing (heuristic, per-category) -------------------------------

  private categorizeTask(input: string): NimModel['category'] | null {
    const text = input.toLowerCase();
    const drugKeywords = ['molecular', 'drug', 'ligand', 'protein-ligand', 'binding', 'affinity',
      'genmol', 'diffdock', 'boltz', 'saf', 'smiles', 'compound', 'molecule', 'docking',
      'hit discovery', 'lead optimization', 'virtual screen', 'qm', 'qed', 'logp'];
    const proteinKeywords = ['protein', 'structure prediction', 'folding', 'sequence design',
      'inverse fold', 'backbone', 'pdb', 'cif', 'openfold', 'mpnn', 'protein design'];
    const genomicsKeywords = ['dna', 'genomic', 'genome', 'nucleotide', 'evo2', 'codon',
      'sequence generation', 'transcript', 'mrna'];

    const drugScore = drugKeywords.filter(k => text.includes(k)).length;
    const proteinScore = proteinKeywords.filter(k => text.includes(k)).length;
    const genomicsScore = genomicsKeywords.filter(k => text.includes(k)).length;

    const max = Math.max(drugScore, proteinScore, genomicsScore);
    if (max === 0) return null;
    if (drugScore === max) return 'drug-discovery';
    if (proteinScore === max) return 'protein';
    return 'genomics';
  }

  private pickBestModel(category: NimModel['category'] | null): NimModel {
    const pool = category
      ? this.models.filter(m => m.category === category)
      : this.models;
    if (pool.length === 0) return this.models[0];
    return this.pickModelFrom(pool);
  }

  private pickModelFrom(pool: NimModel[]): NimModel {
    if (pool.length === 0) throw new Error('Empty model pool');
    return pool[this.modelIndex % pool.length];
  }

  // -- execute ---------------------------------------------------------------

  async execute(req: RoutingRequest): Promise<TaskResult> {
    const startTime = Date.now();
    const category = this.categorizeTask(req.input);
    const model = this.pickBestModel(category);

    const messages: NIMChatRequest['messages'] = [
      {
        role: 'system',
        content: `You are running on NVIDIA NIM (${model.id}). Provide structured, accurate scientific analysis. Include confidence scores where applicable.`,
      },
      { role: 'user', content: req.input },
    ];

    let lastError: Error | null = null;
    let output = '';
    let confidence = 0.5;
    let tokensUsed: number | undefined;
    let responseModel = '';

    for (let attempt = 0; attempt < Math.min(3, this._modelIds.length) && !lastError; attempt++) {
      const currentModel = this.models[attempt] ?? model;
      try {
        let rawRes: NIMChatResponse | NIMGenerationResponse;

        try {
          rawRes = await this.withTimeout(
            this.postChat(currentModel.id, messages),
          );
        } catch (chatErr) {
          // Fall back to /generation endpoint if /chat fails
          const genRes = await this.withTimeout(
            this.postGeneration(currentModel.id, messages),
          ) as unknown as NIMChatResponse;
          rawRes = genRes;
        }

        // Parse chat response
        if ('choices' in rawRes) {
          const chat = rawRes as NIMChatResponse;
          const choice = chat.choices?.[0];
          output = choice?.message?.content ?? '';
          tokensUsed = chat.usage?.total_tokens;
          responseModel = chat.model;
          if (choice?.finish_reason === 'length') confidence = 0.6;
          else if (choice?.finish_reason === 'stop') confidence = 0.85;
        }
        // Parse generation response
        else if ('outputs' in rawRes) {
          const gen = rawRes as NIMGenerationResponse;
          const first = gen.outputs?.[0];
          output = first?.generated_text ?? first?.results?.[0]?.generated_text ?? '';
          const errList = first?.errors;
          if (errList && errList.length > 0) {
            output += `\n[Errors: ${errList.join(', ')}]`;
            confidence = 0.3;
          } else {
            confidence = 0.75;
          }
          responseModel = currentModel.id;
        }

        const latencyMs = Date.now() - startTime;
        return {
          brain: 'nim',
          model: currentModel.id,
          output,
          tokensUsed,
          latencyMs,
        };
      } catch (err) {
        lastError = new Error(`${currentModel.name} failed: ${this.parseError(err)}`);
      }
    }

    throw lastError ?? new Error('All NIM models failed');
  }

  // -- route -----------------------------------------------------------------

  async route(req: RoutingRequest): Promise<RoutingDecision> {
    const category = this.categorizeTask(req.input);
    const model = this.pickBestModel(category);

    const categoryConfidence: Record<string, number> = {
      'drug-discovery': 0.92,
      'protein': 0.90,
      'genomics': 0.88,
    };

    return {
      brain: 'nim',
      model: model.id,
      confidence: category ? (categoryConfidence[category] ?? 0.7) : 0.7,
    };
  }

  // -- model listing ---------------------------------------------------------

  async listModels(): Promise<string[]> {
    return this._modelIds;
  }

  getModels(): NimModel[] {
    return [...this.models];
  }

  // -- health ----------------------------------------------------------------

  async ping(): Promise<boolean> {
    if (this.pingCache && Date.now() - this.pingCache.at < 5 * 60_000) {
      return this.pingCache.ok;
    }
    try {
      const res = await this.withTimeout(
        fetch(`${this.baseUrl}/models`, {
          method: 'GET',
          headers: this.buildHeaders(this.authHeaders()),
        }),
        5000,
      );
      if (!res.ok) {
        this.pingCache = { at: Date.now(), ok: false };
        return false;
      }
      // /models can list models the account is not entitled to; probe one cheaply.
      const model = this._modelIds[0];
      if (!model) {
        this.pingCache = { at: Date.now(), ok: false };
        return false;
      }
      const probe = await this.withTimeout(
        fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.buildHeaders(this.authHeaders()),
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          }),
        }),
        8000,
      );
      const ok = probe.ok;
      this.pingCache = { at: Date.now(), ok };
      return ok;
    } catch {
      this.pingCache = { at: Date.now(), ok: false };
      return false;
    }
  }
}
