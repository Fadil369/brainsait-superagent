/** Lark context reader; retrieved messages are returned for model inspection without entering intake. */
import { z } from 'zod'
import type { Trigger } from './core-types.js'
import type { SourceContext } from './host.js'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.js'
import {
  larkTime, withMentionNames, larkText, topicEvent,
  HistoricalMessageSchema, HistoryPageSchema, type HistoricalMessage, type TopicMessage,
} from './lark-trigger.js'
import { SOURCE, larkRef } from './lark-trigger.js'

/** Retained source message reference anchoring context reads. */
export interface LarkRef { triggerId: string; chatId: string; messageId: string; at?: string }

/** Validates a model-supplied resource string before any network request. */
export function larkResource(resource: string) {
  const match = /^lark\/([^/]+)\/(message|root|parent|thread|around)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[3] && match[2] !== 'thread' && match[2] !== 'around')) {
    throw new Error('Use lark/<trigger-id>/message, /root, /parent, /thread or /around')
  }
  return { triggerId: match[1]!, section: match[2]!, cursor: match[3] ? decodeURIComponent(match[3]) : undefined }
}

/** Resource references anchored to an accepted trigger. */
export function larkReferences(ref: LarkRef) {
  const read = (section: string) => `lark/${ref.triggerId}/${section}`
  return { skill: 'dsh-superagent-lark', message: read('message'), root: read('root'), parent: read('parent'), thread: read('thread'), around: read('around') }
}

async function sourceOf(commands: SourceContext['commands'], ref: LarkRef) {
  const params = JSON.stringify({ message_ids: [ref.messageId] })
  const listed = await commands.lark(['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', params])
  const sourceResult = z.object({ items: z.array(z.object({
    message_id: z.string(), chat_id: z.string(),
    root_id: z.string().optional(), parent_id: z.string().optional(),
    thread_id: z.string().optional(), deleted: z.boolean().optional(),
  })) }).parse(listed)
  const source = sourceResult.items.find(m => m.message_id === ref.messageId)
  if (!source || source.deleted) throw new Error('The source Lark message is unavailable or deleted')
  if (source.chat_id !== ref.chatId) throw new Error('Lark source chat does not match the trigger')
  return source
}

/** A page of messages from Lark context reads. */
export interface LarkPage<M> {
  status: string; thread_id?: string; messages: M[]; next_resource: string | null; skipped?: number
}
export interface LarkOne<M> { status: string; message: M | null }

/** Fetches one message or a bounded topic page with pagination. */
export async function readLark(
  commands: SourceContext['commands'], ref: LarkRef, resource: string,
  pageSize: number, order: 'asc' | 'desc' = 'asc',
): Promise<LarkPage<any> | LarkOne<any>> {
  const request = larkResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A Lark source trigger is required')
  if (request.section === 'around') throw new Error('The chat around a message is read with larkRead')

  const source = await sourceOf(commands, ref)

  if (request.section === 'thread') {
    if (!source.thread_id) return { status: 'no_thread', messages: [], next_resource: null }
    const args = ['im', '+threads-messages-list', '--thread', source.thread_id, '--order', order, '--page-size', String(pageSize), '--no-reactions']
    if (request.cursor) args.push('--page-token', request.cursor)
    const result = z.object({
      messages: z.array(z.unknown()), has_more: z.boolean(),
      page_token: z.string().optional(), thread_id: z.string(),
    }).parse(await commands.lark(args))
    const messages = result.messages
    if (result.has_more && (!result.page_token || result.page_token === request.cursor)) throw new Error('Lark thread pagination did not advance')
    return {
      status: 'available', thread_id: result.thread_id, messages,
      next_resource: result.has_more ? `lark/${ref.triggerId}/thread/${encodeURIComponent(result.page_token!)}` : null,
    }
  }

  const target = request.section === 'root' ? source.root_id : request.section === 'parent' ? source.parent_id : source.message_id
  if (!target) return { status: `no_${request.section}`, message: null }

  const result = z.object({ messages: z.array(z.object({
    message_id: z.string(), chat_id: z.string(), content: z.string().optional(),
    sender: z.object({ id: z.string(), sender_type: z.string() }),
    create_time: z.string(), mentions: z.array(z.object({ id: z.string(), name: z.string().optional(), key: z.string().optional() })).optional(),
    message_app_link: z.string().optional(), parent_id: z.string().optional(), deleted: z.boolean().optional(),
  })) }).parse(await commands.lark(['im', '+messages-mget', '--message-ids', target, '--no-reactions']))
  const message = result.messages.find(m => m.message_id === target)
  if (!message) throw new Error('The requested Lark message is unavailable')
  return { status: message.deleted ? 'deleted' : 'available', message }
}

/** Reads chat messages surrounding a trigger's message for context. */
async function chatAround(commands: SourceContext['commands'], ref: LarkRef, cursor: string | undefined, before = 5, after = 5): Promise<LarkPage<ContextMessage>> {
  const time = Date.parse(ref.at ?? '')
  if (!Number.isFinite(time)) throw new Error('The source Lark message has no time to read the chat around')

  const list = async (parameters: Record<string, unknown>) => {
    const params = JSON.stringify({ container_id_type: 'chat', container_id: ref.chatId, ...parameters })
    const page = HistoryPageSchema.parse(await commands.lark(['api', 'GET', '/open-apis/im/v1/messages', '--params', params]))
    return { ...page, items: page.items.filter((item: any) => item.chat_id === ref.chatId) }
  }

  const earlier = await list({
    end_time: String(Math.ceil(time / 1000)), sort_type: 'ByCreateTimeDesc',
    page_size: cursor ? 10 : before + 1, ...(cursor ? { page_token: cursor } : {}),
  })
  const later = cursor || !after ? [] : (await list({
    start_time: String(Math.floor(time / 1000)), sort_type: 'ByCreateTimeAsc', page_size: after + 1,
  })).items

  const seen = new Set<string>()
  const messages = [...earlier.items.reverse(), ...later]
    .filter((item: any) => !seen.has(item.message_id) && seen.add(item.message_id))
    .map((msg: unknown) => historyView(msg as HistoricalMessage))

  const more = earlier.has_more && earlier.page_token && earlier.page_token !== cursor
  const next = more ? `lark/${ref.triggerId}/around/${encodeURIComponent(earlier.page_token!)}` : null
  return { status: 'available', messages, next_resource: next }
}

function isoTime(value: string): string {
  try { return larkTime(value) } catch { return value }
}

/** Formats a Lark message for model inspection. */
export function larkView(message: { message_id: string; chat_id: string; content?: string; msg_type: string; sender: { id: string; name?: string; sender_type: string }; create_time: string; mentions?: { id: string; name?: string; key?: string }[]; message_app_link?: string; parent_id?: string; deleted?: boolean }): ContextMessage {
  return {
    id: message.message_id,
    from: message.sender.name || message.sender.id,
    at: isoTime(message.create_time),
    text: message.deleted ? '' : withMentionNames(message.content ?? '', message.mentions ?? []),
    ...message.sender.sender_type !== 'user' ? { bot: true } : {},
    ...message.deleted ? { deleted: true } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {},
    ...message.message_app_link ? { url: message.message_app_link } : {},
  }
}

/** Formats a chat history API message for model inspection. */
function historyView(message: HistoricalMessage): ContextMessage {
  return {
    id: message.message_id,
    from: message.sender.id,
    at: isoTime(message.create_time),
    text: message.deleted ? '' : withMentionNames(larkText(message), message.mentions ?? []),
    ...message.sender.sender_type !== 'user' ? { bot: true } : {},
    ...message.deleted ? { deleted: true } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {},
    ...message.message_app_link ? { url: message.message_app_link } : {},
  }
}

/** Main read endpoint for Lark context. */
export async function larkRead(
  commands: SourceContext['commands'], ref: LarkRef, resource: string,
  pageSize: number,
): Promise<LarkPage<ContextMessage> | LarkOne<ContextMessage>> {
  const request = larkResource(resource)
  if (request.section === 'around') {
    if (request.triggerId !== ref.triggerId) throw new Error('A Lark source trigger is required')
    await sourceOf(commands, ref)
    return chatAround(commands, ref, request.cursor)
  }
  const result = await readLark(commands, ref, resource, pageSize)
  if ('messages' in result) return { ...result, messages: result.messages.map((m: any) => larkView(m)) }
  return { status: result.status, message: result.message ? larkView(result.message) : null }
}

function sourceRef(trigger: Trigger): LarkRef {
  const ref = larkRef(trigger)
  if (!ref) throw new Error('A Lark source trigger is required')
  return ref
}

/** Reads recent messages from a Lark chat for polling new triggers. */
export async function larkReadRecent(
  commands: SourceContext['commands'], chatId: string, direct: boolean,
  since: string | undefined, pageSize: number,
): Promise<{ messages: Record<string, unknown>[]; next?: string }> {
  const seconds = (time: string) => String(Math.floor(Date.parse(time) / 1000))
  const endTime = since ? seconds(since) : undefined

  const parameters: Record<string, unknown> = {
    container_id_type: 'chat', container_id: chatId,
    sort_type: 'ByCreateTimeAsc',
    page_size: Math.min(Math.max(pageSize, 1), 50),
  }
  if (endTime) parameters.end_time = endTime

  const params = JSON.stringify(parameters)
  const result = HistoryPageSchema.parse(
    await commands.lark(['api', 'GET', '/open-apis/im/v1/messages', '--params', params])
  )
  const messages = result.items.filter((item: any) => item.chat_id === chatId && !item.deleted)

  return { messages: messages as Record<string, unknown>[], next: result.has_more ? result.page_token : undefined }
}

/** Polls for new messages in a chat, returning only triggers newer than `since`. */
export async function larkPollChat(
  commands: SourceContext['commands'], chatId: string, direct: boolean,
  since: string, botId: string, appId: string, pageSize: number,
): Promise<{ count: number }> {
  const { messages } = await larkReadRecent(commands, chatId, direct, since, pageSize)
  return { count: messages.length }
}

/** Lark thread context reader for assessments. */
export const larkThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands, trigger, part, cursor, config) => {
    const ref = sourceRef(trigger)
    const resource = `lark/${trigger.id}/${part}${cursor ? '/' + encodeURIComponent(cursor) : ''}`
    const body = await larkRead(commands, ref, resource, config.readPageSize)

    if (part === 'thread' && body.status === 'no_thread') {
      const around = await chatAround(commands, ref, undefined, 5, 0)
      return { messages: around.messages, body: { status: 'chat_neighbours', messages: around.messages }, status: 'chat_neighbours' }
    }

    const messages = 'messages' in body ? body.messages : body.message ? [body.message] : []
    const next = 'next_resource' in body && body.next_resource ? decodeURIComponent(body.next_resource.split('/').at(-1)!) : undefined
    return { messages, next, body: { ...body }, status: body.status }
  },
}
