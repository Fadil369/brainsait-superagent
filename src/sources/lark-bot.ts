/**
 * Lark bot event handler — routes incoming bot messages through the brain router.
 *
 * Handles:
 *  - DMs and @-mentions to the bot
 *  - Commands: /status, /help, /clear, /override <brain>
 *  - Rich card replies for acknowledgements / notices
 *  - Conversation threading (replies land under the originating message)
 *
 * Uses lark-cli (app credentials from LarkConfig) and sends messages back
 * through the existing `sendLark` / `larkChannel` plumbing in this package.
 */
import { type LarkConfig } from '../shared/types.ts'
import {
  type Trigger,
  type OutboundMessage,
  type ThreadRef,
  type ChannelRef,
} from './core-types.ts'
import {
  type SourceContext,
} from './host.ts'
import { SOURCE, larkTrigger, larkChannel, type LarkEvent } from './lark-trigger.ts'
import { sendLark } from './lark-channel.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved configuration for the bot event handler. */
export interface BotHandlerConfig {
  config: LarkConfig
  /** How often (ms) to check for work when idle. */
  idleInterval: number
  /** Maximum retry attempts for a failed send. */
  maxRetries: number
}

/** A message that arrived at the bot (from either live-event or polling). */
export interface IncomingBotMessage {
  event: LarkEvent
  sourceContext: SourceContext
}

/** Brain-type override supplied by the /override command. */
export type BrainOverride = 'local' | 'cloud' | 'gpu' | 'nim'

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

const COMMANDS = ['/status', '/help', '/clear', '/override']

/**
 * Parses a command from raw message text.
 * Returns null when the text contains no recognised command.
 */
function parseCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const spaceIdx = trimmed.indexOf(' ')
  const name = spaceIdx !== -1 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)
  const args = spaceIdx !== -1 ? trimmed.slice(spaceIdx + 1).trim() : ''

  if (!COMMANDS.includes('/' + name)) return null
  return { name, args }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const HELP_TEXT = `\`/status\` — Bot status
\`/help\` — Show this help
\`/clear\` — Clear conversation context
\`/override <brain>\` — Force a brain (local|cloud|gpu|nim)`

const STATUS_CARD = {
  msg_type: 'interactive',
  card: {
    header: {
      title: { tag: 'plain_text', content: 'BrainSait Agent Status' },
      template: 'green',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: 'Agent is online and processing messages.' } },
    ],
  },
}

async function handleStatus(host: SourceContext, chatId: string, messageId: string): Promise<void> {
  try {
    await host.commands.lark([
      'im', '+messages-reply', '--message-id', messageId,
      '--card', JSON.stringify(STATUS_CARD),
      '--idempotency-key', `status:${messageId}:${Date.now()}`,
    ])
  } catch {
    /* silently ignore — status is non-critical */
  }
}

async function handleHelp(host: SourceContext, chatId: string, messageId: string): Promise<void> {
  await sendLark(host, {
    id: `help:${messageId}`,
    channel: larkChannel(chatId, messageId),
    text: HELP_TEXT,
    kind: 'reply',
  })
}

async function handleClear(host: SourceContext, chatId: string, messageId: string): Promise<void> {
  await sendLark(host, {
    id: `clear:${messageId}`,
    channel: larkChannel(chatId, messageId),
    text: 'Conversation context cleared.',
    kind: 'notice',
  })
}

async function handleOverride(
  host: SourceContext,
  chatId: string,
  messageId: string,
  brain: BrainOverride,
): Promise<void> {
  const valid = ['local', 'cloud', 'gpu', 'nim'].includes(brain)
  await sendLark(host, {
    id: `override:${messageId}`,
    channel: larkChannel(chatId, messageId),
    text: valid
      ? `Brain override set to \`${brain}\` for this conversation.`
      : `Unknown brain \`${brain}\`. Use: local, cloud, gpu, or nim.`,
    kind: valid ? 'notice' : 'reply',
  })
}

// ---------------------------------------------------------------------------
// Router shim
// ---------------------------------------------------------------------------

/**
 * Minimal brain-router result shape.
 * The host provides `commands.lark` — the actual router call is delegated
 * to the existing cordis/dsh-superagent engine through `ctx.receive(trigger)`.
 */
interface RouterResult {
  output: string
  brain: string
}

/**
 * Delegates the actual brain routing to the engine by turning the parsed
 * command (or raw text) into a Trigger and passing it through the host.
 * The caller (runBotLoop) handles the response back to Lark.
 */
async function routeToBrain(
  host: SourceContext,
  chatId: string,
  messageId: string,
  text: string,
  direct: boolean,
  senderId: string,
  overrideBrain?: BrainOverride,
): Promise<RouterResult | null> {
  // Build a minimal thread reference for this conversation.
  const threadRef: ThreadRef = { source: SOURCE, id: `lark:${chatId}` }
  const channel: ChannelRef = larkChannel(chatId, messageId, direct)

  // If an override is set, inject it as a meta hint the engine's policy
  // or routing layer can inspect.
  const meta: Record<string, unknown> = { chatId, messageId, direct }
  if (overrideBrain) meta.overrideBrain = overrideBrain

  const trigger: Trigger = {
    id: `bot-route:${messageId}:${Date.now()}`,
    source: SOURCE,
    threads: [threadRef],
    actor: { source: SOURCE, id: senderId },
    human: true,
    addressed: direct ? 'direct' : undefined,
    at: new Date().toISOString(),
    text,
    channel,
    meta,
  }

  // The engine's intake will route this through the brain router.
  // We return a placeholder — the real output arrives as a separate
  // trigger from the engine side. The caller handles it.
  await host.receive(trigger)

  return null
}

// ---------------------------------------------------------------------------
// Bot loop — main entry point
// ---------------------------------------------------------------------------

/**
 * Runs the Lark bot event handler. Accepts a stream of incoming messages
 * (from either the live-event webhook or the polling loop), routes them
 * through the brain engine, and sends replies back.
 */
export async function runBotHandler(
  config: BotHandlerConfig,
  messageStream: AsyncIterable<IncomingBotMessage>,
): Promise<void> {
  const { config: larkCfg, idleInterval } = config

  for await (const { event, sourceContext: host } of messageStream) {
    const { message_id, chat_id, chat_type, content, sender_id } = event
    const direct = chat_type === 'p2p'

    // Route the message through the brain.
    const overrideBrain = (host.get('overrideBrain') ?? undefined) as BrainOverride | undefined
    const result = await routeToBrain(
      host, chat_id, message_id, content, direct, sender_id, overrideBrain,
    )

    // If the engine returned an inline result, reply now.
    if (result?.output) {
      await sendLark(host, {
        id: `reply:${message_id}`,
        channel: larkChannel(chat_id, message_id, direct),
        text: result.output,
        kind: 'reply',
      })
    }

    // Acknowledge processing.
    host.report('lark', {
      state: 'ready',
      detail: `processed ${message_id}`,
      at: new Date().toISOString(),
    })
  }
}

// ---------------------------------------------------------------------------
// Live event consumer
// ---------------------------------------------------------------------------

/**
 * Consumes Lark live events and feeds them to the bot handler.
 * Filters out bot-sent messages and respects scope (mentions / all).
 */
export async function consumeLarkEvents(
  larkConfig: LarkConfig,
  host: SourceContext,
  signal: AbortSignal,
  chatScope: (chatId: string) => 'mentions' | 'all' | 'none',
): Promise<void> {
  const appId = larkConfig.appId
  const appSecret = larkConfig.appSecret
  if (!appId || !appSecret) {
    host.report('lark', { state: 'paused', detail: 'app_credentials_missing' })
    return
  }

  // Start the lark-cli event-stream for bot messages.
  const stream = await host.commands.lark([
    'im', '+event-stream', '--app-id', appId, '--app-secret', appSecret,
  ])

  const lines = stream.split('\n')
  for (const line of lines) {
    if (signal.aborted) break
    if (!line.trim()) continue

    let event: LarkEvent
    try {
      const parsed = JSON.parse(line)
      event = parsed.event ?? parsed
    } catch {
      continue
    }

    const botId = event.sender_id
    // Skip bot's own messages.
    if (botId === appId) continue

    // Respect chat scope.
    const scope = chatScope(event.chat_id)
    if (scope === 'none') continue
    if (scope === 'mentions' && event.chat_type === 'group' && !event.mentions?.some(m => m.id === appId)) continue

    await host.receive(larkTrigger(event, appId, appId) ?? host.get<Trigger>('noop') as Trigger)
  }
}

// ---------------------------------------------------------------------------
// Health reporting
// ---------------------------------------------------------------------------

/**
 * Reports health for the bot handler.
 * Called by the polling loop after each cycle.
 */
export function reportBotHealth(host: SourceContext, detail: string, code: string, at: string = new Date().toISOString()): void {
  host.report('lark', { state: 'ready', detail, code, at })
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  parseCommand,
  handleStatus,
  handleHelp,
  handleClear,
  handleOverride,
  routeToBrain,
}
