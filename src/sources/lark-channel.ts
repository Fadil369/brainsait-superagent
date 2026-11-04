/** Lark outbound channel: posts threaded bot replies and constructs chat deep links. */
import type { OutboundMessage } from './core-types.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { SOURCE, larkTriggerId } from './lark-trigger.ts'

/** Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const larkChatLink = (chatId: string): string =>
  `https://applink.larksuite.com/client/chat/open?openChatId=${encodeURIComponent(chatId)}`

/**
 * True when Lark permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Lark response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean =>
  error instanceof Error && error.message !== undefined && (
    error.message.includes('230011')
    || /withdrawn/i.test(error.message)
    || (Math.floor(Number(error.message) / 100) === 2300 && /not found/i.test(error.message))
  )

/**
 * Sends a reply to a Lark message. Uses reply-in-thread mode so the reply appears under the target message.
 * Idempotency key prevents duplicate replies on retries.
 * Rich card support: when `message.kind` is 'acknowledgement' or 'notice', sends a rich card instead of plain text.
 */
export async function sendLark(host: SourceContext, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Lark reply target')

  // Rich card support for agent status messages (acknowledgements, notices).
  if (message.kind === 'acknowledgement' || message.kind === 'notice') {
    const card = {
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: message.kind === 'notice' ? 'Agent Status' : 'Acknowledgement' },
          template: message.kind === 'notice' ? 'blue' : 'green',
        },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: message.text } }],
      },
    }
    const reply = ['im', '+messages-reply', '--message-id', messageId, '--card', JSON.stringify(card), '--idempotency-key', message.id]
    try { await host.commands.lark(reply) }
    catch (error) {
      if (gone(error)) return 'gone'
      throw error
    }
    return 'sent'
  }

  // Plain text reply with thread mode.
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--text', message.text, '--reply-in-thread', '--idempotency-key', message.id]
  try { await host.commands.lark(reply) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}

/** Channel ref factory: `larkChannel(chatId, messageId)`. */
export function larkChannel(chatId: string, messageId?: string) {
  if (!messageId) return undefined
  return { source: SOURCE, thread: `lark:${chatId}`, address: { chatId, messageId } }
}

/**
 * Fallback chat link on Lark; the message's own deep link on its Trigger is preferred when available.
 */
export const larkLink = (address: Record<string, string>): ChannelLink => ({
  url: larkChatLink(address.chatId ?? ''),
  label: { zh: 'Lark 消息', en: 'Lark message' },
  ...address.messageId ? { triggerId: larkTriggerId(address.messageId) } : {},
})

/** Returns the Lark brand ('lark') for use in links and deep URLs. */
export const brand = 'lark' as const
