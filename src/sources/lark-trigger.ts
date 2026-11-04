/** Normalizes Lark messages (live events, chat history, topics) into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from './core-types.ts'

export const SOURCE = 'lark'

/** Channel address for a Lark conversation: group or direct, anchored to a chat and message. */
export interface LarkAddress { chatId: string; messageId: string; direct?: 'true' }

/** Constructs a Lark reply channel address; records `direct` explicitly because both group and direct chat IDs start with `oc_`. */
export const larkChannel = (chatId: string, messageId: string, direct = false): ChannelRef =>
  ({ source: SOURCE, thread: `lark:${chatId}`, address: { chatId, messageId, ...direct ? { direct: 'true' } : {} } })

/** A normalized Lark event from the live-stream consumer or history reader. */
export interface LarkEvent {
  message_id: string
  chat_id: string
  chat_type: 'p2p' | 'group'
  sender_id: string
  sender_type: 'user' | 'bot'
  content: string
  create_time: string
  mentions?: { id: string; key?: string; name?: string }[]
  root_id?: string
  parent_id?: string
  thread_id?: string
  message_app_link?: string
}

/** Parses the event shape the live consumer emits. */
export const EventSchema = z.object({
  message_id: z.string(), chat_id: z.string(),
  chat_type: z.enum(['p2p', 'group']),
  sender_id: z.string(), sender_type: z.enum(['user', 'bot']),
  content: z.string(), create_time: z.string(),
  mentions: z.array(z.object({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).default([]),
  root_id: z.string().optional(), parent_id: z.string().optional(),
  thread_id: z.string().optional(), message_app_link: z.string().optional(),
})

/** A message from the history API; a deleted message may have no body/content. */
export const HistoricalMessageSchema = z.looseObject({
  message_id: z.string(), chat_id: z.string(), create_time: z.string(),
  root_id: z.string().optional(), parent_id: z.string().optional(),
  thread_id: z.string().optional(), deleted: z.boolean().optional(),
  message_app_link: z.string().optional(),
  sender: z.looseObject({ id: z.string().default(''), sender_type: z.string() }),
  body: z.looseObject({ content: z.string() }).optional(),
  mentions: z.array(z.object({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).optional(),
})
export type HistoricalMessage = z.infer<typeof HistoricalMessageSchema>

/** One page of the history API; items are validated individually so an unreadable item is skipped alone. */
export const HistoryPageSchema = z.looseObject({
  items: z.array(z.unknown()).default([]),
  has_more: z.boolean().default(false),
  page_token: z.string().optional(),
})

/** Deterministic trigger ID for a Lark message; every read path for this message produces the same ID. */
export const larkTriggerId = (messageId: string): string => key('lark', messageId)

/**
 * Parses a Lark message timestamp: epoch milliseconds as a string, or a local timestamp such as `2026-09-11 12:00`.
 */
export function larkTime(value: string): string {
  const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`Unreadable Lark message time: ${value}`)
  return new Date(time).toISOString()
}

/** Replaces mention keys in raw content with human-readable @names so the agent sees readable text. */
export const withMentionNames = (text: string, mentions: { key?: string | undefined; name?: string | undefined }[]): string =>
  mentions.reduce((result, mention) =>
    mention.key && mention.name ? result.replaceAll(mention.key, `@${mention.name}`) : result, text)

/**
 * Extracts the plain text content from a Lark message body (JSON rich-text) or returns raw text for plain messages.
 */
export function larkText(message: HistoricalMessage): string {
  let content: unknown
  try { content = JSON.parse(message.body?.content ?? '') }
  catch { content = message.body?.content ?? '' }
  const plain = content && typeof content === 'object' && 'text' in content && typeof content.text === 'string'
    ? content.text : undefined
  return typeof content === 'string' ? content : plain ?? JSON.stringify(content)
}

/**
 * Converts a historical message into the live-event schema shape so the same trigger builder can handle both paths.
 */
export function historyEvent(message: HistoricalMessage, chatId: string, direct: boolean): unknown {
  return {
    message_id: message.message_id, chat_id: chatId,
    chat_type: direct ? 'p2p' : 'group',
    create_time: message.create_time,
    sender_id: message.sender.id,
    sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot',
    content: larkText(message),
    mentions: message.mentions ?? [],
    root_id: message.root_id, parent_id: message.parent_id,
    thread_id: message.thread_id,
    message_app_link: message.message_app_link,
  }
}

/**
 * Adapts a topic-page message into the live-event schema, falling back to `root` when Lark omits `root_id` on replies;
 * an app's message carries its bot's `open_bot_id`, and a deleted message may have no content.
 */
export interface TopicMessage {
  message_id: string; chat_id: string; content?: string;
  sender: { id: string; name?: string; open_bot_id?: string; sender_type: string };
  create_time: string; update_time?: string;
  mentions?: { id: string; name?: string; key?: string }[];
  message_app_link?: string; thread_id?: string; root_id?: string; parent_id?: string;
}

export function topicEvent(message: TopicMessage, chatId: string, direct: boolean, root: string): unknown {
  return {
    message_id: message.message_id, chat_id: chatId,
    chat_type: direct ? 'p2p' : 'group',
    create_time: message.create_time,
    sender_id: message.sender.open_bot_id ?? message.sender.id,
    sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot',
    content: message.content ?? '',
    mentions: message.mentions ?? [],
    parent_id: message.parent_id, thread_id: message.thread_id,
    root_id: message.root_id ?? (message.message_id === root ? undefined : root),
    message_app_link: message.message_app_link,
  }
}

/**
 * Converts a normalized Lark event into a Trigger, returning undefined for messages sent by the bot itself.
 * Supports direct messages (addressed='direct'), group mentions (addressed='mention'), and mentions in threads.
 */
export function larkTrigger(input: unknown, botId: string, botAppId: string): Trigger | undefined {
  const event = EventSchema.parse(input)
  if (event.sender_id === botId || event.sender_id === botAppId) return
  const direct = event.chat_type === 'p2p'
  const mentioned = event.mentions.some(mention => mention.id === botId || mention.id === botAppId)
  return {
    id: larkTriggerId(event.message_id), source: SOURCE,
    threads: [{ source: SOURCE, id: `lark:${event.chat_id}` }],
    actor: { source: SOURCE, id: event.sender_id },
    human: event.sender_type === 'user',
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: larkTime(event.create_time),
    text: withMentionNames(event.content, event.mentions ?? []),
    channel: larkChannel(event.chat_id, event.message_id, direct),
    ...(event.message_app_link ? { url: event.message_app_link } : {}),
    meta: {
      chatId: event.chat_id, messageId: event.message_id, direct, mentioned,
      ...(event.root_id ? { rootId: event.root_id } : {}),
      ...(event.parent_id ? { parentId: event.parent_id } : {}),
      ...(event.thread_id ? { threadId: event.thread_id } : {}),
    },
  }
}

/** Determines the trigger type classification for a Lark message. */
export type LarkTriggerType = 'lark-dm' | 'lark-comment' | 'lark-mention'
export function triggerType(trigger: Trigger): LarkTriggerType {
  if (trigger.meta.direct === true) return 'lark-dm'
  if (trigger.addressed === 'mention') return 'lark-mention'
  return 'lark-comment'
}

/** Returns the ID of the parent trigger if this trigger replies to another message. */
export function larkParent(trigger: Trigger): string | undefined {
  if (trigger.source !== SOURCE || typeof trigger.meta.parentId !== 'string') return undefined
  return larkTriggerId(trigger.meta.parentId)
}

/** A message reference retained from a trigger for context reads and link resolution. */
export interface LarkRef { triggerId: string; chatId: string; messageId: string; at?: string }

/** Extracts the source message reference from a trigger for later context reads. */
export function larkRef(trigger: Trigger): LarkRef | undefined {
  const meta = trigger.meta as { chatId?: string; messageId?: string }
  if (trigger.source !== SOURCE || !meta.chatId || !meta.messageId) return undefined
  return { triggerId: trigger.id, chatId: meta.chatId, messageId: meta.messageId, at: trigger.at }
}
