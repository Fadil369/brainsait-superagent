import type { RoutingDecision, RoutingRequest, TaskResult } from '../../shared/types.js';
import { BrainBase } from '../brain-base.js';
import type { RouterConfig, TaskComplexity } from '../types.js';
import { classifyTask } from '../types.js';

interface RunAICredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

interface AuthResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface RunAIWorkload {
  id: string;
  name: string;
  state: string;
  image: string;
  replicas: number;
  resources: {
    cpu: string;
    gpu: string;
    memory: string;
  };
  created: string;
  completed?: string;
}

interface RunAIWorkloadsResponse {
  workloads: RunAIWorkload[];
}

interface RunAIInferenceRequest {
  model: string;
  inputs?: Record<string, unknown>;
  prompt?: string;
  task: string;
}

interface RunAIInferenceResponse {
  success: boolean;
  result?: unknown;
  error?: string;
  workloadId?: string;
}

type RunAITaskCategory = 'training' | 'inference' | 'scientific';

const NIM_SCIENTIFIC_MODELS = {
  boltz2: 'nim/nvidia/boltz2',
  diffdock: 'nim/nvidia/diffdock',
  genmol: 'nim/nvidia/genmol',
  openfold3: 'nim/nvidia/openfold3',
  msaSearch: 'nim/nvidia/msa-search',
  proteinMpnn: 'nim/nvidia/proteinmpnn',
  rfdiffusion: 'nim/nvidia/rfdiffusion',
} as const;

export class RunAIBrain extends BrainBase {
  readonly name: 'runai' = 'runai';
  private creds: RunAICredentials | null;
  private accessToken: string | null;
  private tokenExpiry: number | null;
  private ollamaBaseUrl: string;
  private ollamaModel: string;
  private nimBaseUrl: string;
  private nimApiKey: string;
  private _mcpCall: ((server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>) | null;

  constructor(
    config: RouterConfig['local'],
    private readonly _mcp?: (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>,
  ) {
    super(MAX_TASK_TIME_MS, 2);
    this.creds = null;
    this.accessToken = null;
    this.tokenExpiry = null;
    this.ollamaBaseUrl = config.baseUrl;
    this.ollamaModel = config.model;
    this.nimBaseUrl = process.env.NIM_BASE_URL || 'http://localhost:8000';
    this.nimApiKey = process.env.NIM_API_KEY || '';
    this._mcpCall = this._mcp ?? null;
    this._loadCredentials();
  }

  async execute(req: RoutingRequest): Promise<TaskResult> {
    const startTime = Date.now();
    const { categories } = classifyTask(req.input);

    try {
      let output: string;

      const isScientific = categories.some(
        c => ['protein', 'molecule', 'drug', 'dock', 'fold', 'sequence', 'bio', 'medical', 'genomics', 'affinity', 'pdb', 'smiles'].includes(c.toLowerCase()),
      );

      if (isScientific) {
        output = await this._runScientific(req.input);
      } else {
        output = await this._submitWorkloadREST(req);
      }

      return {
        brain: 'runai',
        output,
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      const output = await this._fallbackToNim(req.input);
      return {
        brain: 'runai',
        output: `Run:ai fallback triggered: ${this.parseError(err)}\n\nNIM Result:\n${output}`,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  async route(req: RoutingRequest): Promise<RoutingDecision> {
    const hasCreds = !!this.creds;
    const isScientific = classifyTask(req.input).categories.some(
      c => ['protein', 'molecule', 'drug', 'dock', 'fold', 'sequence', 'bio', 'genomics', 'affinity'].includes(c.toLowerCase()),
    );
    const isGpuHeavy = classifyTask(req.input).complexity === 'high';
    const confidence = hasCreds && (isScientific || isGpuHeavy) ? 0.93 : hasCreds ? 0.75 : 0;

    if (confidence === 0) {
      return { brain: 'runai', confidence: 0 };
    }

    return {
      brain: 'runai',
      model: this.creds?.baseUrl || 'runai-cluster',
      confidence,
    };
  }

  async ping(): Promise<boolean> {
    if (!this.creds) return false;
    return true;
  }

  // --- Credential Management ---

  private _loadCredentials(): void {
    const baseUrl = process.env.RUNAI_BASE_URL;
    const clientId = process.env.RUNAI_CLIENT_ID;
    const clientSecret = process.env.RUNAI_CLIENT_SECRET;

    if (baseUrl && clientId && clientSecret) {
      this.creds = { baseUrl, clientId, clientSecret };
    } else {
      this.creds = null;
    }
  }

  private async _authenticate(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.creds) {
      throw new Error('Run:ai credentials not configured');
    }

    const url = `${this.creds.baseUrl}/oauth/token`;
    const res = await this.withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          grant_type: 'client_credentials',
        }),
      }),
      15000,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Run:ai auth failed ${res.status}: ${text.substring(0, 200)}`);
    }

    const data = (await res.json()) as AuthResponse;
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  // --- MCP Integration ---

  private async _mcpSubmitWorkload(params: Record<string, unknown>): Promise<RunAIInferenceResponse> {
    if (!this._mcpCall) {
      throw new Error('MCP client not available');
    }
    const result = await this._mcpCall('runai', 'submit_workload', params);
    return result as RunAIInferenceResponse;
  }

  private async _mcpListWorkloads(): Promise<RunAIWorkload[]> {
    if (!this._mcpCall) return [];
    const result = await this._mcpCall('runai', 'list_workloads', {});
    const data = result as RunAIWorkloadsResponse;
    return data.workloads ?? [];
  }

  private async _mcpGetWorkloadStatus(workloadId: string): Promise<string> {
    if (!this._mcpCall) return 'unknown';
    const result = await this._mcpCall('runai', 'get_workload_status', { workloadId });
    return String(result);
  }

  private async _mcpDeleteWorkload(workloadId: string): Promise<void> {
    if (!this._mcpCall) return;
    await this._mcpCall('runai', 'delete_workload', { workloadId });
  }

  // --- REST API ---

  private _runAIHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.accessToken;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  private async _submitWorkloadREST(req: RoutingRequest): Promise<string> {
    if (!this.creds) throw new Error('Run:ai credentials missing');
    const token = await this._authenticate();

    const workload = {
      name: `brainsait-${Date.now()}`,
      image: 'nvcr.io/nim/nvidia/boltz2:1.0.0',
      replicas: 1,
      resources: { cpu: '8', gpu: '1', memory: '32Gi' },
      command: ['echo', req.input],
    };

    const url = `${this.creds.baseUrl}/apis/run.ai/v1alpha2/namespaces/default/workloads`;
    const res = await this.withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { ...this._runAIHeaders(), 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(workload),
      }),
      MAX_TASK_TIME_MS,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Run:ai workload create ${res.status}: ${text.substring(0, 300)}`);
    }

    const data = await res.json();
    const id = (data.metadata?.name) || (data.id) || 'unknown';
    return `Workload submitted: ${id}`;
  }

  // --- Scientific Task Execution ---

  private async _runScientific(input: string): Promise<string> {
    if (this._mcpCall) {
      try {
        return await this._mcpScientific(input);
      } catch {
        // fall through to REST or NIM
      }
    }

    if (this.creds) {
      return await this._submitWorkloadREST({ input });
    }

    return await this._fallbackToNim(input);
  }

  private async _mcpScientific(input: string): Promise<string> {
    const model = this._detectScientificModel(input);

    const params = {
      task: 'scientific_inference',
      model,
      input,
      nimBaseUrl: this.nimBaseUrl,
      nimApiKey: this.nimApiKey,
    };

    const result = await this._mcpSubmitWorkload(params);
    if (result.success && result.result) {
      return JSON.stringify(result.result, null, 2);
    }
    if (result.error) {
      throw new Error(`Run:ai scientific task failed: ${result.error}`);
    }
    throw new Error('Run:ai scientific task returned no result');
  }

  private _detectScientificModel(input: string): string {
    const text = input.toLowerCase();
    if (text.includes('boltz') || text.includes('affinity') || text.includes('pIC50')) return NIM_SCIENTIFIC_MODELS.boltz2;
    if (text.includes('dock') || text.includes('pose') || text.includes('ligand')) return NIM_SCIENTIFIC_MODELS.diffdock;
    if (text.includes('generate') || text.includes('molecule') || text.includes('saf')) return NIM_SCIENTIFIC_MODELS.genmol;
    if (text.includes('fold') || text.includes('structure') || text.includes('pdb')) return NIM_SCIENTIFIC_MODELS.openfold3;
    if (text.includes('msa') || text.includes('alignment') || text.includes('sequence')) return NIM_SCIENTIFIC_MODELS.msaSearch;
    if (text.includes('design') || text.includes('protein')) return NIM_SCIENTIFIC_MODELS.proteinMpnn;
    if (text.includes('diffuse') || text.includes('backbone')) return NIM_SCIENTIFIC_MODELS.rfdiffusion;
    return NIM_SCIENTIFIC_MODELS.boltz2;
  }

  // --- NIM Fallback ---

  private async _fallbackToNim(input: string): Promise<string> {
    try {
      const model = this._detectScientificModel(input);
      const res = await fetch(`${this.nimBaseUrl}/v1/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.nimApiKey ? { Authorization: `Bearer ${this.nimApiKey}` } : {}),
        },
        body: JSON.stringify({ model, prompt: input, stream: false }),
      });
      if (!res.ok) throw new Error('NIM unavailable');
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    } catch {
      return await this._fallbackToLocal(input);
    }
  }

  private async _fallbackToLocal(input: string): Promise<string> {
    try {
      const res = await fetch(`${this.ollamaBaseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.ollamaModel, prompt: input, stream: false }),
      });
      if (!res.ok) throw new Error('Local Ollama unavailable');
      const data = await res.json();
      return data.response ?? 'Local fallback returned empty response';
    } catch {
      throw new Error('All brains unavailable: Run:ai, local Ollama');
    }
  }

  // --- Workload Management ---

  async listWorkloads(): Promise<RunAIWorkload[]> {
    if (this._mcpCall) {
      return this._mcpListWorkloads();
    }
    if (!this.creds) return [];
    try {
      const token = await this._authenticate();
      const url = `${this.creds.baseUrl}/apis/run.ai/v1alpha2/namespaces/default/workloads`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) return [];
      const data = await res.json() as RunAIWorkloadsResponse;
      return data.workloads ?? [];
    } catch {
      return [];
    }
  }

  async getWorkloadStatus(workloadId: string): Promise<string> {
    if (this._mcpCall) {
      return this._mcpGetWorkloadStatus(workloadId);
    }
    return 'unknown';
  }

  async deleteWorkload(workloadId: string): Promise<void> {
    if (this._mcpCall) {
      await this._mcpDeleteWorkload(workloadId);
      return;
    }
    if (!this.creds) return;
    try {
      const token = await this._authenticate();
      const url = `${this.creds.baseUrl}/apis/run.ai/v1alpha2/namespaces/default/workloads/${encodeURIComponent(workloadId)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`Run:ai delete warning: ${res.status} ${text}`);
      }
    } catch (err) {
      console.error(`Run:ai delete error: ${this.parseError(err)}`);
    }
  }

  // --- NIM Direct Callers ---

  async callBoltz2(pdb: string, smiles?: string): Promise<unknown> {
    const res = await fetch(`${this.nimBaseUrl}/v1/docking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.nimApiKey ? { Authorization: `Bearer ${this.nimApiKey}` } : {}),
      },
      body: JSON.stringify({ pdb, smiles }),
    });
    return res.json();
  }

  async callDiffDock(pdb: string, smiles: string): Promise<unknown> {
    const res = await fetch(`${this.nimBaseUrl}/v1/docking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.nimApiKey ? { Authorization: `Bearer ${this.nimApiKey}` } : {}),
      },
      body: JSON.stringify({ pdb, smiles }),
    });
    return res.json();
  }

  async callGenMol(saf?: string, scaffold?: string): Promise<unknown> {
    const res = await fetch(`${this.nimBaseUrl}/v1/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.nimApiKey ? { Authorization: `Bearer ${this.nimApiKey}` } : {}),
      },
      body: JSON.stringify({ saf, scaffold }),
    });
    return res.json();
  }

  async callOpenFold(fasta: string): Promise<unknown> {
    const res = await fetch(`${this.nimBaseUrl}/v1/predict`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.nimApiKey ? { Authorization: `Bearer ${this.nimApiKey}` } : {}),
      },
      body: JSON.stringify({ fasta }),
    });
    return res.json();
  }
}

const MAX_TASK_TIME_MS = 10 * 60 * 1000;
