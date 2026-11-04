/**
 * Core type definitions for dsh-superagent source plugins.
 * Copied from @deepseek-ai/cordis so source plugins compile standalone.
 */
import { createHash } from 'node:crypto'

/** A stable content-derived identifier. */
export function key(...values: string[]): string {
  const hash = createHash('sha256').update(JSON.stringify(values)).digest('hex')
  return hash.slice(0, 32)
}

/** A thread reference that the engine uses to group messages. */
export interface ThreadRef { source: string; id: string }

/**
 * Where a trigger was addressed to the agent: direct message, a mention, or neither.
 * The Policy's admission table gates what becomes a candidate request.
 */
export type Addressed = 'direct' | 'mention' | undefined

/** A Trigger is a single message/event that the engine may turn into work. */
export interface Trigger {
  id: string
  source: string
  threads: ThreadRef[]
  /** The sender who originated the message. */
  actor: { source: string; id: string }
  /** True for human senders; bots and apps can never authorize work on their own. */
  human: boolean
  /** How the agent was addressed: direct, a mention, or absent. */
  addressed?: Addressed
  /** Timestamp in ISO-8601 when the message was created. */
  at: string
  /** The raw message text (mention keys already resolved to @names). */
  text: string
  /** The channel the agent should reply to; absent for system events like CI. */
  channel?: ChannelRef
  /** A URL to the source message or resource. */
  url?: string
  /** Kind-specific metadata read by scope, policy, and thread context readers. */
  meta: Record<string, unknown>
}

/** A channel ref names where a reply should go: source, thread key, and an opaque address. */
export interface ChannelRef {
  source: string
  thread: string
  address: Record<string, string>
}

/** An outbound message queued for delivery to a thread's channel. */
export interface OutboundMessage {
  id: string
  channel: ChannelRef
  text: string
  kind: 'acknowledgement' | 'reply' | 'notice'
  ticketId?: string
}

/** A thread representing a conversation or topic in a Source. */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  lastAt?: string
  title?: string
  url?: string
  meta: Record<string, unknown>
  subscriptions: string[]
}

/** A named fact the Source shows on a Thread card. */
export interface ThreadFact {
  label: string | { zh: string; en: string }
  value: string | { zh: string; en: string }
  problem?: boolean
}

/** Result of the Policy gate for a trigger. */
export interface GateResult {
  admitted: boolean
  reason?: string
}
