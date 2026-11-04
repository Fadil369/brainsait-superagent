/**
 * Standalone Lark event webhook server.
 *
 * Listens on LARK_WEBHOOK_PORT (default 3084) and accepts event callbacks at
 * /webhook (and /lark/webhook when mounted behind a path-prefixed proxy).
 * Responds to Lark's url_verification challenge, verifies the token when one
 * is configured, de-duplicates events, and dispatches asynchronously so Lark
 * always gets a fast 200.
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { Router } from '../router/router.js';
import { memory } from '../memory/store.js';
import { handleLarkEvent, larkAppId, type LarkMessageEvent } from './bot.js';

const PORT = Number(process.env.LARK_WEBHOOK_PORT ?? 3084);
const PATH_PREFIX = (process.env.LARK_WEBHOOK_PATH ?? '').replace(/\/$/, '');
const VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN ?? '';
const ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY ?? '';

function decrypt(encrypted: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const buffer = Buffer.from(encrypted, 'base64');
  const iv = buffer.subarray(0, 16);
  const ciphertext = buffer.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString('utf-8');
}

const router = new Router();
const appId = (() => {
  try {
    return larkAppId();
  } catch {
    return '';
  }
})();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/health' || path.endsWith('/health'))) {
    json(res, 200, {
      ok: true,
      app: appId || 'unconfigured',
      memory: memory().stats(),
      brains: router.getConfig().manualOverride,
    });
    return;
  }

  const webhookPaths = new Set(['/webhook', '/lark/webhook', `${PATH_PREFIX}/webhook`]);
  if (req.method !== 'POST' || !webhookPaths.has(path)) {
    json(res, 404, { error: 'not_found', path });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 400, { error: 'unreadable_body' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json(res, 400, { error: 'invalid_json' });
    return;
  }

  // Encrypted payloads (optional).
  if (typeof body.encrypt === 'string') {
    if (!ENCRYPT_KEY) {
      json(res, 400, { error: 'encrypted_payload_but_no_key' });
      return;
    }
    try {
      body = JSON.parse(decrypt(body.encrypt, ENCRYPT_KEY)) as Record<string, unknown>;
    } catch {
      json(res, 400, { error: 'decrypt_failed' });
      return;
    }
  }

  // URL verification challenge.
  if (typeof body.challenge === 'string') {
    json(res, 200, { challenge: body.challenge });
    return;
  }

  // Token verification (v1 body.token or v2 header.token).
  const header = (body.header ?? {}) as Record<string, unknown>;
  const token = String(body.token ?? header.token ?? '');
  if (VERIFICATION_TOKEN && token !== VERIFICATION_TOKEN) {
    json(res, 403, { error: 'invalid_token' });
    return;
  }

  const eventId = String(header.event_id ?? body.uuid ?? '');
  if (eventId && !memory().firstSeen(eventId)) {
    json(res, 200, { code: 0, msg: 'duplicate' });
    return;
  }

  // Acknowledge immediately; Lark requires a fast response.
  json(res, 200, { code: 0, msg: 'ok' });

  void handleLarkEvent(router, body as unknown as LarkMessageEvent).catch((error) => {
    console.error('[lark] dispatch failed:', error instanceof Error ? error.message : error);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[lark] webhook listening on :${PORT} (app ${appId || 'unconfigured'})`);
  console.log(`[lark] post events to http://<host>:${PORT}/webhook`);
});
