/** Lark source kind definition, polling loop, and Cordis plugin entry. */
import { z } from 'zod'
import { type SourceContext, health } from './host.js'
import { SOURCE, larkChannel, larkTrigger, larkTriggerId, type LarkEvent, type HistoricalMessage }
  from './lark-trigger.js'
import { larkLink, sendLark } from './lark-channel.js'
import { larkThreadContext, larkReadRecent, larkRead, larkReferences, type LarkRef } from './lark-read.js'
import type { Localized, SourceKind } from './kind.js'

export { SOURCE, larkChannel, larkTriggerId, larkTrigger } from './lark-trigger.js'
export { larkReadRecent, larkRead, larkReferences, larkRead as larkContextRead } from './lark-read.js'
export type { LarkEvent, HistoricalMessage } from './lark-trigger.js'
export type { LarkRef } from './lark-read.js'
export { larkLink, sendLark } from './lark-channel.js'

/** Lark source configuration schema. */
const LarkConfigSchema = z.object({
  cli: z.string().trim().default(''),
  readPageSize: z.number().int().min(1).max(50).default(20),
  pollSeconds: z.number().int().min(10).max(3600).default(60),
  chats: z.array(z.object({
    chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/),
    name: z.string().trim().max(60).optional(),
    listen: z.enum(['mentions', 'all']).default('mentions'),
  }).strict()).default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type LarkConfig = z.infer<typeof LarkConfigSchema>

/** A resolved Lark bot from deployment config. */
export interface LarkBot { cli: string; appId: string; brand: 'lark'; botId: string; name: string }

export const larkKind: SourceKind<LarkConfig> = {
  kind: SOURCE,
  title: { zh: 'Lark', en: 'Lark' },
  description: { zh: '接收下列群和私聊中发给机器人的消息，补收群历史并轮询订阅的线程。', en: 'Receives messages to the bot in these chats and direct messages, recovers chat history and polls subscribed Threads.' },
  schema: LarkConfigSchema,
  fields: [
    {
      key: 'cli', type: 'text',
      label: { zh: '机器人的 Lark CLI', en: 'Bot Lark CLI' },
      hint: { zh: '命令名或绝对路径，指向只允许机器人身份的 Lark CLI 配置。', en: 'A command name or absolute path of a Lark configuration restricted to bot identity.' },
    },
    {
      key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '"仅 @"只接收 @ 机器人的消息；"全部消息"也接收其余消息。', en: '"@ only" receives messages that mention the bot; "All" also receives the rest.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat' }, pattern: 'oc_[a-zA-Z0-9]+' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' },
          options: [
            { value: 'mentions', label: { zh: '仅 @', en: '@ only' } },
            { value: 'all', label: { zh: '全部消息', en: 'All' } },
          ],
        },
      ],
    },
    {
      key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' },
      options: [
        { value: 'none', label: { zh: '不接收', en: 'Not received' } },
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } },
      ],
      hint: { zh: '机器人已加入但没列在上面的群。', en: 'Chats the bot has joined that are not listed above.' },
    },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' } },
  ],
  health: ['lark'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages
      ? { listened: true, observed: false, row: 'direct' }
      : { listened: false, reason: 'direct_messages_not_allowed' as const }
    const chat = config.chats.find((item: { chatId: string; listen: 'mentions' | 'all' }) => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions'
      ? { listened: true, observed: false, row: 'other' }
      : { listened: false, reason: 'chat_not_allowed' as const }
  },
  channel: {
    send: sendLark, link: larkLink,
  },
  threadContext: larkThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  repliesTo: trigger => {
    const parentId = typeof trigger.meta.parentId === 'string' ? trigger.meta.parentId : undefined
    return parentId ? larkTriggerId(parentId) : undefined
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^(ou_[a-zA-Z0-9]+)$/), name: z.string().trim().max(100).optional() })).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^(cli|ou)_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() })).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Lark 用户', en: 'Lark users who may originate work' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'open_id', en: 'open_id' }, pattern: 'ou_[a-zA-Z0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ],
      },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'App ID 或 open_id', en: 'App ID or open_id' }, pattern: '(cli|ou)_[a-zA-Z0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ],
      },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request.' },
    rows(stored) {
      const config = LarkConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map((chat: { chatId: string; name?: string; listen: 'mentions' | 'all' }) => ({
          id: chat.chatId, label: chat.name || chat.chatId,
          note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' },
        })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' },
          note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' },
          note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_LARK_BOT', description: { zh: 'Lark 机器人；CLI 以它行事', en: 'The Lark bot; CLI acts as it' } },
      { key: 'DSH_SUPERAGENT_LARK_CHAT', description: { zh: '接下工单的 Lark 群 chat_id', en: 'chat_id of the Lark chat that started the ticket' } },
    ],
    values: ({ deployment, trigger }) => ({
      DSH_SUPERAGENT_LARK_BOT: (deployment as { feishu?: { name?: string; botId?: string } })?.feishu?.name || (deployment as { feishu?: { name?: string; botId?: string } })?.feishu?.botId || '',
      DSH_SUPERAGENT_LARK_CHAT: trigger?.source === SOURCE ? String((trigger.meta as { chatId?: string }).chatId ?? '') : '',
    }),
  },
  facts: (deployment): Record<string, Localized | string> => {
    const feishu = (deployment as { feishu?: { name?: string; botId?: string } })?.feishu
    return feishu ? { cli: { zh: `当前机器人 ${feishu.name || feishu.botId || ''}`, en: `Current bot ${feishu.name || feishu.botId || ''}` } } : {}
  },
}

/** Returns the Lark Source's settings, falling back to schema defaults. */
export const larkSettings = (sources: { instance: <T>(k: string) => { config: T } | undefined }): LarkConfig =>
  sources.instance<LarkConfig>(SOURCE)?.config ?? LarkConfigSchema.parse({})

/** Polling loop: reads new messages from configured chats, emits triggers. */
export async function runLark(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 0)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })

  const enabled = (): LarkConfig | undefined => ctx.config<LarkConfig>()
  const bot = (): LarkBot | undefined => {
    const d = ctx.config<LarkConfig>()
    if (!d?.cli) return undefined
    return { cli: d.cli, appId: '', brand: 'lark', botId: '', name: '' }
  }

  if (!ctx.configured()) {
    ctx.report('lark', { state: 'paused', detail: 'setupPending' })
    return
  }

  const chatListKey = 'lark:chats'
  const seenChats = ctx.get<Record<string, boolean>>(chatListKey) ?? {}

  while (!signal.aborted) {
    const config = enabled()
    if (!config) {
      ctx.report('lark', { state: 'paused', detail: 'sourceOff' })
      await new Promise<void>(r => setTimeout(r, 60_000))
      continue
    }

    const larkBot = bot()
    if (!larkBot) {
      ctx.report('lark', { state: 'paused', detail: 'larkBotMissing' })
      await new Promise<void>(r => setTimeout(r, 30_000))
      continue
    }

    const chatList = [...config.chats.map((c: { chatId: string; listen: 'mentions' | 'all' }) => ({ chatId: c.chatId, direct: false, listen: c.listen }))]

    // Direct chats discovered via live events.
    const directChats = Object.entries(seenChats)
      .filter(([, isDirect]) => isDirect && config.directMessages)
      .map(([chatId]) => ({ chatId, direct: true, listen: 'all' as const }))

    const allChats = [...chatList, ...directChats]
    const errors: string[] = []

    for (const chat of allChats) {
      if (signal.aborted) break

      const checkpointKey = `lark:history:${chat.chatId}`
      const since = ctx.get<string>(checkpointKey)
      if (since === undefined) {
        ctx.set(checkpointKey, new Date().toISOString())
        continue
      }

      try {
        const result = await larkReadRecent(ctx.commands, chat.chatId, chat.direct ?? false, since, config.readPageSize)
        const { larkTrigger: triggerBuilder } = await import('./lark-trigger.js')
        const botId = larkBot.botId
        const appId = larkBot.appId

        for (const msgUnknown of result.messages) {
          const msg = msgUnknown as any
          const event = {
            message_id: msg.message_id, chat_id: chat.chatId,
            chat_type: chat.direct ? 'p2p' : 'group',
            content: msg.body?.content ?? String(msg.content ?? ''),
            create_time: msg.create_time,
            sender_id: msg.sender?.id ?? msg.sender_id ?? '',
            sender_type: msg.sender?.sender_type ?? msg.sender_type ?? 'user' as const,
            mentions: msg.mentions ?? [],
            root_id: msg.root_id, parent_id: msg.parent_id,
            thread_id: msg.thread_id, message_app_link: msg.message_app_link,
          }
          const trigger = triggerBuilder(event, botId, appId)
          if (trigger) await ctx.receive(trigger)
        }

        ctx.set(checkpointKey, new Date().toISOString())
      } catch (error) {
        if (!signal.aborted) errors.push(`${chat.chatId}: ${String(error)}`)
      }
    }

    if (errors.length) {
      ctx.report('lark', { state: 'error', detail: `${errors.length} reads failed: ${errors.join('; ')}` })
    } else {
      ctx.report('lark', { state: 'ready', detail: `${allChats.length} chats polled`, at: new Date().toISOString() })
    }

    const interval = (config.pollSeconds ?? 60) * 1000
    await new Promise<void>(r => {
      const timer = setTimeout(r, interval)
      signal.addEventListener('abort', () => { clearTimeout(timer); r() }, { once: true })
    })
  }
}

/** Plugin entry point. */
export const name = 'dsh-superagent-lark'

/** Register the Lark source kind and start the polling loop. */
export function apply(ctx: { orchestrator?: { sources?: { register: (kind: SourceKind<Record<string, unknown>>) => void } }; effect: (fn: () => (() => Promise<void>)) => void; report?: (source: string, health: unknown) => void }): void {
  if (ctx.orchestrator?.sources) {
    ctx.orchestrator.sources.register(larkKind)
  }
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runLark(ctx as unknown as SourceContext, controller.signal)
      .catch((error: unknown) => { ctx.report?.('lark', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
