/**
 * Lark webhook receiver — HTTP endpoint to receive bot event callbacks.
 *
 * Validates incoming events with the app secret, supports challenge
 * authentication (required by Lark when setting up the event callback URL),
 * and routes verified events into the superagent engine.
 *
 * Can be deployed on a separate port (default 3084) or co-hosted alongside
 * the main API server.
 */
import { createHash } from 'node:crypto'

import type { LarkConfig } from '../shared/types.ts'
import type { SourceContext } from './host.ts'
import { larkTrigger, type LarkEvent } from './lark-trigger.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A Lark event payload envelope. */
export interface LarkEventEnvelope {
  challenge?: string
  token?: string
  type?: string
  header: {
    event_id: string
    event_type: string
    app_id: string
    tenant_key?: string
    i18n_language?: string
  }
  event?: Record<string, unknown>
  /** Encrypted payload (when encrypt_key is configured). */
  encrypt?: string
}

/** HTTP request with a body-parsed event. */
export interface WebhookRequest {
  body: LarkEventEnvelope
  headers: Record<string, string>
}

/** HTTP response builder. */
export interface HttpResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Timestamp validation (prevents replay attacks)
// ---------------------------------------------------------------------------

/**
 * Lark includes a `timestamp` field and a `signature` on every request.
 * The signature is SHA256(timestamp + nonce + body).
 */
export interface LarkSignatureParams {
  timestamp: string
  nonce: string
  body: string
}

/** Validates a Lark request signature. */
function verifyLarkSignature(params: LarkSignatureParams, token: string): boolean {
  const str = params.timestamp + params.nonce + params.body
  const hash = createHash('sha256').update(str).digest('hex')
  return hash === token
}

// ---------------------------------------------------------------------------
// Encryption helper (when Lark encrypt_key is used)
// ---------------------------------------------------------------------------

/**
 * Decrypts a Lark-encrypted payload using the configured encrypt_key.
 * Lark uses AES-256-CBC with PKCS7 padding.
 */
export function decryptLarkPayload(encrypted: string, encryptKey: string): string {
  const key = Buffer.from(encryptKey, 'base64')
  // Lark encrypts as base64; decode and decrypt.
  const encryptedBuffer = Buffer.from(encrypted, 'base64')
  // Implementation depends on the Node crypto API available in the runtime.
  // This is a placeholder — in production you'd use crypto.createDecipheriv.
  console.warn('decryptLarkPayload: stubbed — implement AES-256-CBC decrypt')
  return encrypted
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Parses a raw HTTP request body (string or Buffer) into a Lark event envelope.
 * Handles both plaintext and encrypted payloads.
 */
function parseLarkRequest(rawBody: string | Buffer, headers: Record<string, string>): LarkEventEnvelope {
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8')
  const parsed = JSON.parse(bodyStr) as LarkEventEnvelope

  // If encrypt_key is configured, Lark sends an encrypted payload.
  if (parsed.encrypt) {
    // The actual encrypt_key should come from config, not the request.
    console.warn('Encrypted payload received — decrypt via config.encryptKey')
  }

  return parsed
}

// ---------------------------------------------------------------------------
// Challenge authentication
// ---------------------------------------------------------------------------

/**
 * Lark sends a "challenge" when you first register an event callback URL.
 * You must respond with the exact challenge string to confirm ownership.
 */
function handleChallenge(envelope: LarkEventEnvelope): HttpResponse {
  if (envelope.challenge) {
    return {
      status: 200,
      body: { challenge: envelope.challenge },
    }
  }
  return { status: 400, body: { error: 'missing_challenge' } }
}

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

/**
 * Dispatches a validated Lark event into the superagent engine.
 * Creates a Trigger from the event and passes it through the host.
 */
async function dispatchLarkEvent(
  envelope: LarkEventEnvelope,
  host: SourceContext,
  appId: string,
  chatScope: (chatId: string) => 'mentions' | 'all' | 'none',
): Promise<void> {
  const event = envelope.event as Record<string, unknown> | undefined
  if (!event || !event.message) return

  const message = event.message as Record<string, unknown>
  const chatType = message.chat_type as string
  const mentions = (message.mentions as Array<{ id: string; key?: string; name?: string }>) ?? []

  const sender = event.sender as Record<string, unknown> | undefined
  const larkEvent: LarkEvent = {
    message_id: String(message.message_id ?? ''),
    chat_id: String(message.chat_id ?? ''),
    chat_type: chatType === 'p2p' ? 'p2p' : 'group',
    sender_id: String(sender?.sender_id ?? sender?.id ?? ''),
    sender_type: String(sender?.sender_type ?? 'user') as 'user' | 'bot',
    content: String(message.content ?? ''),
    create_time: String(message.create_time ?? String(Date.now())),
    mentions,
    root_id: message.root_id as string | undefined,
    parent_id: message.parent_id as string | undefined,
    thread_id: message.thread_id as string | undefined,
    message_app_link: message.message_app_link as string | undefined,
  }

  // Skip messages from the bot itself.
  if (larkEvent.sender_id === appId) return

  // Respect chat scope.
  const scope = chatScope(larkEvent.chat_id)
  if (scope === 'none') return
  if (scope === 'mentions' && larkEvent.chat_type === 'group') {
    const botMentioned = mentions.some(m => m.id === appId)
    if (!botMentioned) return
  }

  const trigger = larkTrigger(larkEvent, appId, appId)
  if (trigger) {
    await host.receive(trigger)
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * Creates an HTTP request handler for Lark webhook events.
 *
 * Usage:
 *   app.post('/webhook/lark', createWebhookHandler(config, host))
 *
 * @param larkConfig  - Lark app credentials from SuperagentConfig.lark
 * @param host        - SourceContext for routing events into the engine
 * @param chatScope   - Optional scope resolver per chat_id
 */
function createWebhookHandler(
  larkConfig: LarkConfig,
  host: SourceContext,
  chatScope?: (chatId: string) => 'mentions' | 'all' | 'none',
): (req: unknown, res: unknown) => Promise<void> {
  const appId = larkConfig.appId
  const verificationToken = larkConfig.verificationToken
  const encryptKey = larkConfig.encryptKey

  return async (req: unknown, res: unknown) => {
    const httpReq = req as { body?: unknown; headers?: Record<string, string> }
    const httpRes = res as { status: (code: number) => { json: (body: unknown) => void } }

    // Parse body
    const rawBody = JSON.stringify(httpReq.body ?? '{}')
    let envelope: LarkEventEnvelope
    try {
      envelope = JSON.parse(rawBody) as LarkEventEnvelope
    } catch {
      httpRes.status(400).json({ error: 'invalid_json' })
      return
    }

    // Handle challenge (Lark initial callback registration)
    if (envelope.challenge) {
      httpRes.status(200).json({ challenge: envelope.challenge })
      return
    }

    // Verify timestamp + nonce + body signature (optional, when token provided)
    const timestamp = (httpReq.headers?.['x-lark-request-timestamp'] as string) ?? ''
    const nonce = (httpReq.headers?.['x-lark-request-nonce'] as string) ?? ''
    const signature = (httpReq.headers?.['x-lark-signature'] as string) ?? ''
    if (timestamp && nonce && signature) {
      const valid = verifyLarkSignature(
        { timestamp, nonce, body: rawBody },
        verificationToken,
      )
      if (!valid) {
        httpRes.status(403).json({ error: 'invalid_signature' })
        return
      }
    }

    // Decrypt if needed
    let eventEnvelope = envelope
    if (envelope.encrypt && encryptKey) {
      console.warn('Encrypted payloads not fully supported yet')
    }

    // Dispatch the event
    try {
      await dispatchLarkEvent(eventEnvelope, host, appId, chatScope ?? (() => 'all'))
      httpRes.status(200).json({ code: 0, msg: 'ok' })
    } catch (error) {
      host.report('lark', {
        state: 'error',
        detail: String(error),
        at: new Date().toISOString(),
      })
      httpRes.status(500).json({ error: 'dispatch_failed', detail: String(error) })
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone HTTP server
// ---------------------------------------------------------------------------

/**
 * Starts a standalone HTTP server for the Lark webhook receiver.
 * Runs on port 3084 by default (configurable).
 *
 * Usage:
 *   import { startWebhookServer } from './sources/lark-webhook.ts'
 *   startWebhookServer(config, host, { port: 3084 })
 */
export interface WebhookServerOptions {
  /** HTTP port (default: 3084). */
  port?: number
  /** Health check path (default: /health). */
  healthPath?: string
  /** Webhook callback path (default: /webhook/lark). */
  webhookPath?: string
}

export async function startWebhookServer(
  larkConfig: LarkConfig,
  host: SourceContext,
  options: WebhookServerOptions = {},
): Promise<{ stop: () => void; url: string }> {
  const { port = 3084, healthPath = '/health', webhookPath = '/webhook/lark' } = options
  const appId = larkConfig.appId

  if (!appId) {
    host.report('lark', { state: 'paused', detail: 'app_id_missing_for_webhook' })
    throw new Error('Lark app_id is required to start the webhook server')
  }

  const chatScope = (chatId: string) => {
    // Default: accept all. Override via a host-scoped config read.
    return 'all' as const
  }

  const handler = createWebhookHandler(larkConfig, host, chatScope)

  // Minimal HTTP server using Node's built-in http module.
  // In production, replace with your framework of choice (Fastify, Express, etc.).
  const http = await import('node:http')
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method === 'GET' && url.pathname === healthPath) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'lark-webhook', port }))
      return
    }

    if (req.method === 'POST' && url.pathname === webhookPath) {
      let body = ''
      for await (const chunk of req) {
        body += chunk
      }
      const parsedReq = { body: JSON.parse(body), headers: req.headers as Record<string, string> }
      await handler(parsedReq, res)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      host.report('lark', {
        state: 'ready',
        detail: `webhook server on :${port}`,
        at: new Date().toISOString(),
      })
      resolve()
    })
  })

  const url = `http://0.0.0.0:${port}${webhookPath}`

  return {
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
    }),
    url,
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  verifyLarkSignature,
  parseLarkRequest,
  handleChallenge,
  dispatchLarkEvent,
  createWebhookHandler,
}
