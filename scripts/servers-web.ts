#!/usr/bin/env node --import tsx/dist/cli.mjs
/**
 * servers-web.ts — Static file server + API proxy for the SuperAgent web panel.
 *
 * Serves:
 *   GET  / — index.html
 *   GET  /index.tsx, /App.tsx, etc. — static TSX (served as-is; browser loads via module)
 *   GET  /api/* — proxied to DSH management API at :3082
 *   WS   /ws/activity — real-time activity stream via Server-Sent Events
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from '../src/router/index.js';
import { DEFAULT_ROUTER_CONFIG } from '../src/router/types.js';
import type { BrainType } from '../src/shared/types.js';

const PORT = 3083;
const DSH_API = 'http://127.0.0.1:3082';
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'src', 'web');

// ── In-memory state (mirrors the live router) ──────────────────────────────

interface Ticket {
  id: string;
  subject: string;
  description: string;
  status: 'open' | 'resolved' | 'escalated' | 'in-progress';
  brain: BrainType;
  confidence: number;
  routerOutput: string;
  tokensUsed?: number;
  latencyMs?: number;
  timestamp: string;
}

interface ActivityEntry {
  id: string;
  timestamp: string;
  status: 'success' | 'error' | 'warning' | 'info';
  type: string;
  message: string;
}

const tickets: Ticket[] = [];
const activities: ActivityEntry[] = [];
const sseClients = new Set<import('node:http').ServerResponse>();

let ticketCounter = 0;
let activityCounter = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

function addActivity(status: ActivityEntry['status'], type: string, message: string) {
  activityCounter += 1;
  const entry: ActivityEntry = {
    id: `act-${activityCounter}`,
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    status,
    type,
    message,
  };
  activities.unshift(entry);
  if (activities.length > 500) activities.length = 500;

  // Broadcast to SSE clients
  const payload = JSON.stringify(entry);
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`); } catch { /* dead client */ }
  }
}

function addTicket(subject: string, brain: BrainType, confidence: number, routerOutput: string, latencyMs: number) {
  ticketCounter += 1;
  const ticket: Ticket = {
    id: `TK-${String(ticketCounter).padStart(4, '0')}`,
    subject,
    description: subject,
    status: 'open',
    brain,
    confidence,
    routerOutput,
    latencyMs,
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  tickets.unshift(ticket);
  if (tickets.length > 200) tickets.length = 200;
  addActivity('info', 'ticket', `Ticket ${ticket.id} created: ${subject}`);
}

function readStatic(path: string): string | null {
  try {
    return readFileSync(join(WEB_DIR, path), 'utf-8');
  } catch {
    return null;
  }
}

// ── Router wrapper (exposes state via API) ─────────────────────────────────

const router = new Router(DEFAULT_ROUTER_CONFIG);

async function simulateRouter(input: string) {
  const start = Date.now();
  try {
    const decision = await router.decide({ input });
    const result = await router.run({ input });
    addActivity('success', 'router', `Routed → ${result.brain} (${result.latencyMs}ms): ${input.slice(0, 80)}`);
    return { decision, result };
  } catch (err) {
    const latency = Date.now() - start;
    addActivity('error', 'router', `Failed: ${err instanceof Error ? err.message : 'unknown'}`);
    throw err;
  }
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static files ──
  if (pathname === '/' || pathname === '/index.html') {
    const body = readStatic('index.html');
    if (body) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(body); return; }
  }

  const staticFile = readStatic(pathname.slice(1));
  if (staticFile) {
    const ext = extname(pathname);
    const ct: Record<string, string> = {
      '.html': 'text/html', '.tsx': 'text/plain', '.ts': 'text/plain',
      '.js': 'text/javascript', '.json': 'application/json',
      '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
    };
    res.writeHead(200, { 'Content-Type': ct[ext] || 'application/octet-stream' });
    res.end(staticFile);
    return;
  }

  // ── SSE / WebSocket for activity ──
  if (pathname === '/ws/activity') {
    const upgrade = req.headers.upgrade?.toLowerCase();
    if (upgrade === 'websocket') {
      // Handle WebSocket upgrade (simple pong/keepalive)
      const socket = res;
      socket.writeHead(101, { Upgrade: 'websocket', Connection: 'Upgrade' });
      socket.end();
      addActivity('info', 'ws', 'WebSocket client connected');
      return;
    }
    // Fallback: Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── API routes ──

  // Health
  if (pathname === '/api/health') {
    const health = {
      agentRunning: true,
      activeBrain: router.getConfig().manualOverride.forceBrain ?? 'local',
      local: true,
      cloud: true,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  // Learning stats
  if (pathname === '/api/learning-stats') {
    const stats = router.getLearningStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  // Router config
  if (pathname === '/api/router-config') {
    const config = router.getConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  // Manual override
  if (pathname === '/api/router/override' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { brain } = JSON.parse(body);
        const bType = brain as BrainType | null;
        router.setManualOverride(bType);
        addActivity('info', 'override', `Manual override set to: ${bType ?? 'auto'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, brain: bType }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Bad request' }));
      }
    });
    return;
  }

  // Tickets
  if (pathname.startsWith('/api/tickets')) {
    const parts = pathname.split('/');
    // GET /api/tickets/:id/resolve
    if (parts[4] === 'resolve' && parts[5] === undefined && req.method === 'POST') {
      const id = parts[4];
      const ticket = tickets.find(t => t.id === parts[3]);
      if (ticket) {
        ticket.status = 'resolved';
        addActivity('success', 'ticket', `Ticket ${id} resolved`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      return;
    }
    // GET /api/tickets/:id
    if (parts.length === 4 && parts[3]) {
      const ticket = tickets.find(t => t.id === parts[3]);
      if (ticket) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ticket));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      return;
    }
    // GET /api/tickets?limit=N
    if (pathname === '/api/tickets' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') ?? '50');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tickets.slice(0, limit)));
      return;
    }
  }

  // Activity log
  if (pathname === '/api/activity' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') ?? '100');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(activities.slice(0, limit)));
    return;
  }

  // Config
  if (pathname === '/api/config') {
    const config = {
      dsh: {
        dshGateway: 'http://localhost:3082',
        dshKey: '',
        ollama: { baseUrl: 'http://localhost:11434', model: 'qwen3:8b' },
        cloud: { gatewayUrl: 'http://100.110.98.65/v1', apiKey: '' },
        gpu: { baseUrl: 'https://api.run.ai', token: '', agentPool: '', agentImage: 'nvidia/nemo:latest' },
        nim: { baseUrl: 'https://ai.api.nvidia.com', apiKey: '' },
      },
      lark: { appId: '', appSecret: '', verificationToken: '' },
      port: PORT,
      logLevel: 'info',
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  // ── Proxy to DSH management API ──
  if (pathname.startsWith('/api/dsh/')) {
    const proxyUrl = `${DSH_API}${pathname.replace('/api/dsh/', '/')}`;

    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await new Promise<string>(resolve => {
        const chunks: string[] = [];
        req.on('data', chunk => { chunks.push(chunk); });
        req.on('end', () => resolve(chunks.join('')));
      });
    }

    const proxyRes = await fetch(proxyUrl, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'],
        'authorization': req.headers['authorization'],
        host: new URL(DSH_API).host,
      },
      body,
    });

    const responseBody = await proxyRes.text();
    res.writeHead(proxyRes.status, {
      'Content-Type': proxyRes.headers.get('content-type') || 'application/json',
    });
    res.end(responseBody);
    return;
  }

  // ── 404 ──
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// ── Seed demo data ─────────────────────────────────────────────────────────

const DEMO_TASKS = [
  { input: 'explain how tailwind css works', brain: 'local', latency: 120 },
  { input: 'debug this race condition in async code', brain: 'cloud', latency: 3400 },
  { input: 'translate "hello world" to French', brain: 'local', latency: 80 },
  { input: 'design a microservices architecture for e-commerce', brain: 'cloud', latency: 4200 },
  { input: 'list all Kubernetes deployment strategies', brain: 'local', latency: 200 },
  { input: 'analyze memory leak in Node.js application', brain: 'cloud', latency: 5100 },
  { input: 'format this JSON array', brain: 'local', latency: 50 },
  { input: 'implement a Redis-backed rate limiter', brain: 'cloud', latency: 2800 },
  { input: 'what is the capital of Saudi Arabia', brain: 'local', latency: 60 },
  { input: 'optimize this PostgreSQL query for performance', brain: 'cloud', latency: 3100 },
];

function seedDemoData() {
  for (const task of DEMO_TASKS) {
    const success = Math.random() > 0.15;
    const decision = success ? Math.random() * 0.3 + 0.7 : Math.random() * 0.3 + 0.1;

    // Record in learning system
    router.getLearningStats();
    addTicket(task.input, task.brain as BrainType, decision, `Routed to ${task.brain} for: ${task.input.slice(0, 50)}`, task.latency);

    addActivity(
      success ? 'success' : 'error',
      'task',
      `${success ? '✓' : '✗'} ${task.input.slice(0, 60)} → ${task.brain} (${task.latency}ms)`
    );
  }
}

seedDemoData();

// ── Periodic demo data ─────────────────────────────────────────────────────

setInterval(async () => {
  try {
    const randomTask = DEMO_TASKS[Math.floor(Math.random() * DEMO_TASKS.length)];
    const decision = Math.random() * 0.3 + 0.7;
    addTicket(randomTask.input, randomTask.brain as BrainType, decision, `Routed to ${randomTask.brain}`, randomTask.latency);
  } catch {
    // ignore
  }
}, 30000);

// ── Start ──────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n  🧠 BrainSAIT SuperAgent Monitor`);
  console.log(`  Panel:  http://localhost:${PORT}`);
  console.log(`  DSH API: ${DSH_API}`);
  console.log(`\n  Press Ctrl+C to stop\n`);
});
