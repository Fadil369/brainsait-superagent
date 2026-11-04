import type { RoutingDecision, RoutingRequest, TaskResult } from '../../shared/types.js';
import { BrainBase } from '../brain-base.js';
import type { RouterConfig, TaskComplexity } from '../types.js';
import { classifyTask } from '../types.js';

interface GpuConfig {
  gpu?: RouterConfig['gpu'];
}

interface DshSettings {
  gpu?: {
    baseUrl?: string;
    token?: string;
    agentPool?: string;
    agentImage?: string;
  };
}

interface BrevInstance {
  name: string;
  state: string;
  spec: {
    gpuType: string;
    gpuCount: number;
    cpu: number;
    ram: number;
  };
  desiredState: string;
  message: string;
}

interface BrevExecRequest {
  cmd: string;
}

interface BrevExecResponse {
  output: string;
  error: string;
  exitCode: number;
}

interface BrevListResponse {
  objects: BrevInstance[];
}

type NIMTaskType = 'code' | 'scientific';

interface NIMTaskConfig {
  taskType: NIMTaskType;
  model: string;
  prompt?: string;
  inputs?: Record<string, unknown>;
}

const GRACE_PERIOD_MS = 5 * 60 * 1000;
const MAX_TASK_TIME_MS = 10 * 60 * 1000;
const BREV_API = 'https://api.brev.cloud';

export class GpuBrain extends BrainBase {
  readonly name: 'gpu' = 'gpu';
  private brevApiKey: string;
  private dshSettings: DshSettings | null;
  private ollamaBaseUrl: string;
  private ollamaModel: string;
  private agentPool: string;
  private agentImage: string;
  private currentInstanceName: string | null;
  private nimBaseUrl: string;
  private nimApiKey: string;

  constructor(config: RouterConfig['local'], dshConfig?: RouterConfig['gpu']) {
    super(MAX_TASK_TIME_MS, 1);
    this.brevApiKey = process.env.BREV_API_KEY || '';
    this.dshSettings = null;
    this.ollamaBaseUrl = config.baseUrl;
    this.ollamaModel = config.model;
    this.agentPool = dshConfig?.agentPool || '';
    this.agentImage = dshConfig?.agentImage || '';
    this.nimBaseUrl = dshConfig?.baseUrl || 'http://localhost:8000';
    this.nimApiKey = dshConfig?.token || '';
    this.currentInstanceName = null;
  }

  private async _safeRequireYaml(): Promise<typeof import('yaml') | null> {
    try {
      const mod = await import('yaml');
      return mod;
    } catch {
      return null;
    }
  }

  private async _loadDshSettings(): Promise<void> {
    const yaml = await this._safeRequireYaml();
    if (!yaml) return;

    const fs = this._safeRequire('fs');
    if (!fs) return;

    const home = process.env.HOME || '';
    const settingsPath = `${home}/.dsh/settings.yaml`;
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const parsed = yaml.parse(raw);
      this.dshSettings = parsed as DshSettings;
      if (parsed.gpu?.token && !this.brevApiKey) {
        this.brevApiKey = parsed.gpu.token;
      }
    } catch {
      this.brevApiKey = process.env.BREV_API_KEY || '';
    }
  }

  private _safeRequire(modName: string): typeof import('fs') | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any).require?.(modName) || null;
    } catch {
      return null;
    }
  }

  private brevHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.brevApiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async _brevPost<TReq, TRes>(endpoint: string, body?: TReq): Promise<TRes> {
    const res = await this.withTimeout(
      fetch(`${BREV_API}${endpoint}`, {
        method: 'POST',
        headers: this.brevHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      }),
      MAX_TASK_TIME_MS,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Brev API ${res.status}: ${text.substring(0, 300)}`);
    }
    return res.json() as Promise<TRes>;
  }

  async _brevGet<TRes>(endpoint: string): Promise<TRes> {
    const res = await this.withTimeout(
      fetch(`${BREV_API}${endpoint}`, {
        method: 'GET',
        headers: this.brevHeaders(),
      }),
      MAX_TASK_TIME_MS,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Brev API ${res.status}: ${text.substring(0, 300)}`);
    }
    return res.json() as Promise<TRes>;
  }

  async createInstance(): Promise<BrevInstance> {
    if (!this.brevApiKey) {
      throw new Error('Brev API key not configured');
    }

    const gpuSpec = this.dshSettings?.gpu || {};
    const createBody = {
      name: `brainsait-gpu-${Date.now()}`,
      gpuType: 'H100',
      gpuCount: 1,
      cpu: 8,
      ram: 32,
      disk: 100,
      ...(gpuSpec.agentPool ? { project: gpuSpec.agentPool } : {}),
    };

    const instance = await this._brevPost<Record<string, unknown>, BrevInstance>('/api/v1/instances', createBody);
    this.currentInstanceName = instance.name;
    return instance;
  }

  async waitForInstanceReady(name: string, timeoutMs?: number): Promise<boolean> {
    const deadline = Date.now() + (timeoutMs ?? GRACE_PERIOD_MS);
    while (Date.now() < deadline) {
      try {
        const instances = await this._brevGet<BrevListResponse>('/api/v1/instances');
        const inst = instances.objects?.find(i => i.name === name);
        if (inst?.state === 'up' || inst?.desiredState === 'up') {
          return true;
        }
      } catch {
        // continue polling
      }
      await new Promise(r => setTimeout(r, 10000));
    }
    return false;
  }

  async execCommand(cmd: string, instanceName?: string): Promise<BrevExecResponse> {
    const target = instanceName || this.currentInstanceName;
    if (!target) {
      throw new Error('No instance to exec against');
    }

    const result = await this._brevPost<BrevExecRequest, BrevExecResponse>(
      `/api/v1/instances/${encodeURIComponent(target)}/exec`,
      { cmd },
    );
    return result;
  }

  async deleteInstance(name?: string): Promise<void> {
    const target = name || this.currentInstanceName;
    if (!target) return;

    try {
      const res = await fetch(`${BREV_API}/api/v1/instances/${encodeURIComponent(target)}`, {
        method: 'DELETE',
        headers: this.brevHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`Brev delete warning: ${res.status} ${text}`);
      }
    } finally {
      if (!name) this.currentInstanceName = null;
    }
  }

  async sshCommand(cmd: string, instanceName?: string): Promise<string> {
    const target = instanceName || this.currentInstanceName;
    if (!target) throw new Error('No instance for SSH');
    const result = await this.execCommand(cmd, target);
    return result.output || result.error;
  }

  private async _runCodeTask(prompt: string): Promise<string> {
    const instance = await this.createInstance();
    const instanceName = instance.name;

    try {
      const ready = await this.waitForInstanceReady(instanceName);
      if (!ready) {
        throw new Error(`Instance ${instanceName} not ready after grace period`);
      }

      const dshCmd = `dsh-superagent --prompt "${prompt.replace(/"/g, '\\"')}" --timeout 600`;
      const result = await this.execCommand(dshCmd, instanceName);
      return result.output || (result.error ? `[Error] ${result.error}` : 'No output');
    } finally {
      try {
        await this.deleteInstance(instanceName);
      } catch {
        console.error(`Failed to clean up instance ${instanceName}`);
      }
    }
  }

  private async _runScientificTask(config: NIMTaskConfig): Promise<string> {
    const endpoint = this.nimBaseUrl;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.nimApiKey) {
      headers['Authorization'] = `Bearer ${this.nimApiKey}`;
    }

    const payload: Record<string, unknown> = {
      model: config.model,
      ...(config.prompt ? { prompt: config.prompt } : {}),
      ...(config.inputs || {}),
    };

    if (config.taskType === 'scientific') {
      const modelId = config.model.toLowerCase();
      if (modelId.includes('boltz') || modelId.includes('boltz2')) {
        return this._callBoltz2(endpoint, headers, payload);
      } else if (modelId.includes('diffdock')) {
        return this._callDiffDock(endpoint, headers, payload);
      } else if (modelId.includes('genmol')) {
        return this._callGenMol(endpoint, headers, payload);
      } else if (modelId.includes('openfold')) {
        return this._callOpenFold(endpoint, headers, payload);
      }
    }

    const res = await this.withTimeout(
      fetch(`${endpoint}/v1/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }),
      MAX_TASK_TIME_MS,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`NIM ${res.status}: ${text.substring(0, 300)}`);
    }
    const data = await res.json();
    return JSON.stringify(data, null, 2);
  }

  private async _callBoltz2(base: string, headers: Record<string, string>, payload: Record<string, unknown>): Promise<string> {
    const res = await this.withTimeout(
      fetch(`${base}/v1/diffdock`, { method: 'POST', headers, body: JSON.stringify(payload) }),
      MAX_TASK_TIME_MS,
    );
    if (!res.ok) throw new Error(`Boltz2 NIM ${res.status}`);
    return (await res.json()).toString();
  }

  private async _callDiffDock(base: string, headers: Record<string, string>, payload: Record<string, unknown>): Promise<string> {
    const res = await this.withTimeout(
      fetch(`${base}/v1/docking`, { method: 'POST', headers, body: JSON.stringify(payload) }),
      MAX_TASK_TIME_MS,
    );
    if (!res.ok) throw new Error(`DiffDock NIM ${res.status}`);
    return (await res.json()).toString();
  }

  private async _callGenMol(base: string, headers: Record<string, string>, payload: Record<string, unknown>): Promise<string> {
    const res = await this.withTimeout(
      fetch(`${base}/v1/generate`, { method: 'POST', headers, body: JSON.stringify(payload) }),
      MAX_TASK_TIME_MS,
    );
    if (!res.ok) throw new Error(`GenMol NIM ${res.status}`);
    return (await res.json()).toString();
  }

  private async _callOpenFold(base: string, headers: Record<string, string>, payload: Record<string, unknown>): Promise<string> {
    const res = await this.withTimeout(
      fetch(`${base}/v1/predict`, { method: 'POST', headers, body: JSON.stringify(payload) }),
      MAX_TASK_TIME_MS,
    );
    if (!res.ok) throw new Error(`OpenFold NIM ${res.status}`);
    return (await res.json()).toString();
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
      throw new Error('All brains unavailable: Brev, local Ollama');
    }
  }

  async execute(req: RoutingRequest): Promise<TaskResult> {
    const startTime = Date.now();
    const { complexity, categories } = classifyTask(req.input);

    try {
      let output: string;

      const isScientific = categories.some(
        c => ['protein', 'molecule', 'drug', 'dock', 'fold', 'sequence', 'bio', 'medical', 'genomics', 'affinity'].includes(c.toLowerCase()),
      );
      const isCode = categories.some(
        c => ['code', 'function', 'class', 'api', 'deploy', 'docker', 'typescript', 'debug'].includes(c.toLowerCase()),
      );

      if (isScientific) {
        output = await this._runScientificTask({
          taskType: 'scientific',
          model: this.agentPool || 'boltz2-nim',
          prompt: req.input,
        });
      } else if (isCode || complexity === 'high') {
        output = await this._runCodeTask(req.input);
      } else {
        output = await this._fallbackToLocal(req.input);
      }

      return {
        brain: 'gpu',
        output,
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      const output = await this._fallbackToLocal(req.input);
      return {
        brain: 'gpu',
        output: `GPU fallback triggered: ${this.parseError(err)}\n\nResult:\n${output}`,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  async route(req: RoutingRequest): Promise<RoutingDecision> {
    const { complexity } = classifyTask(req.input);
    const hasGpuKey = !!this.brevApiKey;
    const isGpuTask = complexity === 'high' || req.input.toLowerCase().includes('gpu') || req.input.toLowerCase().includes('train');
    const confidence = hasGpuKey && isGpuTask ? 0.95 : hasGpuKey ? 0.8 : 0;

    if (confidence === 0) {
      return {
        brain: 'gpu',
        confidence: 0,
      };
    }

    return {
      brain: 'gpu',
      model: this.agentPool || 'h100',
      confidence,
    };
  }

  async ping(): Promise<boolean> {
    if (!this.brevApiKey) return false;
    try {
      const res = await this.withTimeout(
        fetch(`${BREV_API}/api/v1/user`, { headers: this.brevHeaders() }),
        5000,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async getAvailableInstances(): Promise<BrevInstance[]> {
    if (!this.brevApiKey) return [];
    try {
      const data = await this._brevGet<BrevListResponse>('/api/v1/instances');
      return data.objects ?? [];
    } catch {
      return [];
    }
  }
}
