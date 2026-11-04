import { execFileSync, spawnSync } from 'node:child_process';
import type { RoutingDecision, RoutingRequest, TaskResult } from '../../shared/types.js';
import { BrainBase } from '../brain-base.js';
import type { NimBrainConfig, NimModel } from './nim.js';
import { NIM_MODELS } from './nim.js';

// ---------------------------------------------------------------------------
// Docker types
// ---------------------------------------------------------------------------

export interface NimContainerState {
  name: string;
  image: string;
  running: boolean;
  port: number;
  health: 'healthy' | 'unhealthy' | 'starting' | 'unknown';
  createdAt?: number;
  lastStarted?: number;
}

export interface NimLocalConfig {
  apiKey: string;
  portBase?: number; // base port for NIM containers (default 8000)
  models?: string[]; // model IDs to pre-heat
  timeoutMs?: number;
  maxRetries?: number;
  dockerSocket?: string;
}

const DEFAULT_PORT_BASE = 8000;
const NIM_REGISTRY = 'nvcr.io/nim/';
const DOCKER_TIMEOUT_MS = 120000; // 2 min for pull + start
const HEALTH_CHECK_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// Docker exec helpers
// ---------------------------------------------------------------------------

function docker(args: string[], opts?: { timeout?: number; silent?: boolean }): string {
  const result = spawnSync(
    'docker',
    args,
    {
      encoding: 'utf-8',
      timeout: opts?.timeout,
      stdio: opts?.silent ? ['ignore', 'pipe', 'ignore'] : 'pipe',
    },
  );

  if (result.error) {
    throw new Error(`docker ${args[0]}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    const stdout = result.stdout?.trim() ?? '';
    throw new Error(`docker ${args[0]} exited ${result.status}: ${stderr || stdout}`);
  }
  return (result.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
// NIM Local Brain — fallback when API quota exhausted
// ---------------------------------------------------------------------------

export class NimLocalBrain extends BrainBase {
  readonly name: 'nim-local' = 'nim-local';
  private apiKey: string;
  private portBase: number;
  private dockerSocket: string;
  private containerStates: Map<string, NimContainerState>;
  private models: NimModel[];

  constructor(config: NimLocalConfig) {
    super(config.timeoutMs ?? DOCKER_TIMEOUT_MS, config.maxRetries ?? 2);
    this.apiKey = config.apiKey;
    this.portBase = config.portBase ?? DEFAULT_PORT_BASE;
    this.dockerSocket = config.dockerSocket ?? '/var/run/docker.sock';
    this.containerStates = new Map();
    this.models = config.models
      ? NIM_MODELS.filter(m => config.models!.includes(m.id))
      : [...NIM_MODELS];
  }

  // -- container lifecycle ---------------------------------------------------

  /** Pull the NIM image for a model. */
  pullImage(modelId: string): void {
    const nimImage = this.resolveImage(modelId);
    console.log(`[nim-local] Pulling ${nimImage}...`);
    docker(['pull', nimImage], { timeout: 300000, silent: true });
  }

  /** Start a NIM container for the given model. Returns container name. */
  startContainer(modelId: string, port?: number): string {
    const nimImage = this.resolveImage(modelId);
    const modelTag = modelId.replace(/[\/\-\:]/g, '_').toLowerCase();
    const containerName = `nim-${modelTag}`;
    const targetPort = port ?? this.getPort(modelId);

    // Check if already running
    const existing = this.getContainerState(modelId);
    if (existing?.running) {
      console.log(`[nim-local] Container ${containerName} already running on port ${existing.port}`);
      return containerName;
    }

    // Stop old container if exists
    this.stopContainer(modelId);

    console.log(`[nim-local] Starting ${containerName} from ${nimImage} on port ${targetPort}...`);
    docker([
      'run', '-d',
      '--name', containerName,
      '-p', `${targetPort}:8000`,
      '-e', 'NGC_API_KEY=' + this.apiKey,
      '--gpus', 'all',
      '--shm-size=16g',
      '--health-cmd', 'curl -f http://localhost:8000/v1/health/ready || exit 1',
      '--health-interval', '10s',
      '--health-timeout', '5s',
      '--health-retries', '5',
      '--health-start-period', '60s',
      nimImage,
    ], { timeout: 30000 });

    // Record state
    this.containerStates.set(modelId, {
      name: containerName,
      image: nimImage,
      running: false,
      port: targetPort,
      health: 'starting',
      createdAt: Date.now(),
      lastStarted: Date.now(),
    });

    // Wait for health
    this.waitForHealth(containerName, targetPort);
    return containerName;
  }

  /** Stop and optionally remove a NIM container. */
  stopContainer(modelId: string, remove = false): void {
    const state = this.containerStates.get(modelId);
    if (!state) return;

    try {
      docker(['stop', state.name], { timeout: 30000 });
      if (remove) {
        docker(['rm', '-f', state.name], { silent: true });
      }
    } catch {
      // Container may already be stopped — non-fatal
    }

    const updated = { ...state, running: false, health: 'unknown' as const };
    this.containerStates.set(modelId, updated);
  }

  /** Tear down all containers and free resources. */
  teardown(): void {
    for (const modelId of this.containerStates.keys()) {
      this.stopContainer(modelId, true);
    }
    this.containerStates.clear();
  }

  // -- health ---------------------------------------------------------------

  /** Wait until container reports healthy. Polls docker inspect. */
  private waitForHealth(containerName: string, port: number): void {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const health = docker(['inspect', '--format', '{{.State.Health.Status}}', containerName]);
        if (health === 'healthy') {
          this.containerStates.set(containerName.replace('nim-', ''), {
            ...this.containerStates.get(containerName.replace('nim-', ''))!,
            running: true,
            health: 'healthy',
          });
          console.log(`[nim-local] ${containerName} is healthy`);
          return;
        }
      } catch {
        // Container may not exist yet
      }
      // Also try HTTP health check
      try {
        const res = spawnSync('curl', ['-sf', `http://localhost:${port}/v1/health/ready`], {
          encoding: 'utf-8', timeout: 5000,
        });
        if (res.status === 0) {
          this.containerStates.set(containerName.replace('nim-', ''), {
            ...this.containerStates.get(containerName.replace('nim-', ''))!,
            running: true,
            health: 'healthy',
          });
          return;
        }
      } catch { /* not ready yet */ }
      console.log(`[nim-local] Waiting for ${containerName}... attempt ${i + 1}/${maxAttempts}`);
      // eslint-disable-next-line no-loop-func
      setTimeout(() => {}, HEALTH_CHECK_INTERVAL_MS);
    }
    console.warn(`[nim-local] ${containerName} did not become healthy within timeout`);
  }

  /** Check current health of all containers. */
  refreshHealth(): void {
    for (const [modelId, state] of this.containerStates) {
      try {
        const health = docker(['inspect', '--format', '{{.State.Health.Status}}', state.name]);
        const running = docker(['inspect', '--format', '{{.State.Running}}', state.name]);
        this.containerStates.set(modelId, {
          ...state,
          running: running === 'true',
          health: (health === 'healthy' ? 'healthy' :
            health === 'unhealthy' ? 'unhealthy' :
              state.health),
        });
      } catch {
        this.containerStates.set(modelId, { ...state, running: false, health: 'unknown' });
      }
    }
  }

  // -- model resolution -----------------------------------------------------

  /** Map a model ID to a full NIM Docker image name. */
  resolveImage(modelId: string): string {
    // Examples:
    //   ai-nemo/genmol           → nvcr.io/nim/ai-nemo/genmol:latest
    //   jbaydar/diffdock         → nvcr.io/nim/jbaydar/diffdock:latest
    //   ibm/openfold3            → nvcr.io/nim/ibm/openfold3:latest
    //   meta/evo2               → nvcr.io/nim/meta/evo2:latest
    if (modelId.includes(':')) return modelId; // full reference
    return `${NIM_REGISTRY}${modelId}:latest`;
  }

  /** Get the port assigned to a model. */
  getPort(modelId: string): number {
    const idx = this.models.findIndex(m => m.id === modelId);
    if (idx >= 0) return this.portBase + idx;
    // Fallback: hash-based port
    let hash = 0;
    for (const ch of modelId) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    return this.portBase + Math.abs(hash) % 100;
  }

  // -- local API call -------------------------------------------------------

  private async localChat(modelId: string, messages: Array<{ role: string; content: string }>): Promise<string> {
    const port = this.getPort(modelId);
    const res = await this.withTimeout(
      fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'localhost',
          messages,
          stream: false,
          temperature: 0.3,
          max_tokens: 8192,
        }),
      }),
      60000,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Local NIM HTTP ${res.status}: ${body.substring(0, 500)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  // -- execute ---------------------------------------------------------------

  async execute(req: RoutingRequest): Promise<TaskResult> {
    const startTime = Date.now();

    // Find best model from available
    const model = this.models[0];
    if (!model) {
      throw new Error('No NIM models configured for local inference');
    }

    // Start container if not running
    const state = this.containerStates.get(model.id);
    if (!state?.running) {
      this.startContainer(model.id);
    }

    const messages = [
      { role: 'system', content: 'You are running NVIDIA NIM locally. Provide structured, scientifically accurate responses with confidence scores.' },
      { role: 'user', content: req.input },
    ];

    const output = await this.localChat(model.id, messages);
    const latencyMs = Date.now() - startTime;

    return {
      brain: 'nim-local',
      model: model.id,
      output,
      latencyMs,
    };
  }

  // -- route -----------------------------------------------------------------

  async route(req: RoutingRequest): Promise<RoutingDecision> {
    const state = this.models[0]
      ? this.containerStates.get(this.models[0].id)
      : null;
    const available = state?.running && state.health === 'healthy';

    return {
      brain: 'nim-local',
      model: this.models[0]?.id ?? '',
      confidence: available ? 0.85 : 0.3,
    };
  }

  // -- state queries ---------------------------------------------------------

  getContainerState(modelId: string): NimContainerState | undefined {
    return this.containerStates.get(modelId);
  }

  getAllStates(): NimContainerState[] {
    return Array.from(this.containerStates.values());
  }

  isAvailable(modelId?: string): boolean {
    if (modelId) {
      const state = this.containerStates.get(modelId);
      return (state?.running ?? false) && state?.health === 'healthy';
    }
    // Check if any model container is healthy
    for (const [, state] of this.containerStates) {
      if (state.running && state.health === 'healthy') return true;
    }
    return false;
  }

  /** Get container logs (last N lines). */
  getLogs(modelId: string, tail = 100): string {
    const state = this.containerStates.get(modelId);
    if (!state) return `[nim-local] No container found for ${modelId}`;
    try {
      return docker(['logs', '--tail', String(tail), state.name]);
    } catch {
      return `[nim-local] Failed to retrieve logs for ${state.name}`;
    }
  }

  // -- ping ------------------------------------------------------------------

  async ping(): Promise<boolean> {
    this.refreshHealth();
    for (const [, state] of this.containerStates) {
      if (state.running && state.health === 'healthy') return true;
    }
    return false;
  }
}
