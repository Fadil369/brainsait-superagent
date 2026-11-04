/**
 * Lark bot brain: turns incoming message events into router calls and replies,
 * with persistent memory and a few operator commands.
 */
import type { BrainType } from '../shared/types.js';
import type { Router } from '../router/router.js';
import { memory } from '../memory/store.js';
import {
  botInfo,
  extractText,
  larkCredentials,
  replyText,
  sendText,
} from './api.js';

export interface LarkEventHeader {
  event_id: string;
  event_type: string;
  app_id?: string;
  tenant_key?: string;
}

export interface LarkMessageEvent {
  header: LarkEventHeader;
  event: {
    sender: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
    message: {
      message_id: string;
      chat_id: string;
      chat_type: 'p2p' | 'group';
      message_type: string;
      content: string;
      create_time?: string;
      mentions?: Array<{ id?: string; key?: string; name?: string }>;
    };
  };
}

const BRAINS: BrainType[] = ['local', 'cloud', 'gpu', 'nim', 'nim-local', 'runai'];
const MAX_CHUNK = 3500;

let cachedBotOpenId: string | null = null;

async function botOpenId(): Promise<string | null> {
  if (cachedBotOpenId) return cachedBotOpenId;
  try {
    const info = await botInfo();
    cachedBotOpenId = info.open_id ?? null;
    return cachedBotOpenId;
  } catch {
    return null;
  }
}

function chunks(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_CHUNK) out.push(text.slice(i, i + MAX_CHUNK));
  return out;
}

async function send(messageId: string, chatId: string, text: string): Promise<void> {
  const parts = chunks(text || '(empty response)');
  await replyText(messageId, parts[0] ?? '');
  for (const part of parts.slice(1)) await sendText(chatId, part);
}

function helpText(): string {
  return [
    'BrainSAIT superagent commands:',
    '/status — brain health + memory stats',
    '/override <brain|auto> — force local, cloud, gpu, nim, nim-local, runai',
    '/memory <query> — search remembered turns',
    '/remember <key>: <value> — store a durable fact',
    '/clear — forget this chat',
    '/help — this message',
    '',
    'Anything else is routed to the best available brain.',
  ].join('\n');
}

async function handleCommand(
  router: Router,
  chatId: string,
  text: string,
): Promise<string | null> {
  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  const command = (rawCommand ?? '').toLowerCase();
  const argument = rest.join(' ').trim();

  switch (command) {
    case '/help':
      return helpText();

    case '/status': {
      const pings = await router.pingAll();
      const stats = memory().stats();
      return [
        'Brains:',
        ...Object.entries(pings).map(([name, up]) => `  ${up ? 'up' : 'down'}  ${name}`),
        '',
        `Memory: ${stats.messages} messages, ${stats.chats} chats, ${stats.facts} facts`,
        `Model override: ${router.getConfig().manualOverride.forceBrain ?? 'auto'}`,
      ].join('\n');
    }

    case '/clear': {
      const removed = memory().clear(chatId);
      return `Forgot ${removed} message${removed === 1 ? '' : 's'} from this chat.`;
    }

    case '/memory': {
      if (!argument) return 'Usage: /memory <query>';
      const hits = memory().recall(argument, 8, chatId);
      if (hits.length === 0) return 'Nothing relevant remembered yet.';
      return hits
        .map((hit) => `${hit.role} · ${hit.ts.slice(0, 16)}\n${hit.text.slice(0, 400)}`)
        .join('\n\n');
    }

    case '/remember': {
      if (!argument) return 'Usage: /remember <key>: <value>';
      const split = argument.indexOf(':');
      const key = (split === -1 ? argument : argument.slice(0, split)).trim();
      const value = (split === -1 ? argument : argument.slice(split + 1)).trim();
      if (!key || !value) return 'Usage: /remember <key>: <value>';
      memory().addFact(key, value);
      return `Remembered: ${key} = ${value}`;
    }

    case '/override': {
      if (!argument || argument === 'auto') {
        router.setManualOverride(null);
        return 'Override cleared — routing automatically.';
      }
      if (!BRAINS.includes(argument as BrainType)) {
        return `Unknown brain "${argument}". Choose: ${BRAINS.join(', ')} or auto.`;
      }
      router.setManualOverride(argument as BrainType);
      return `Routing forced to ${argument}.`;
    }

    default:
      return null;
  }
}

/** Handles one verified event. Returns false when the event is ignored. */
export async function handleLarkEvent(router: Router, envelope: LarkMessageEvent): Promise<boolean> {
  if (envelope.header.event_type !== 'im.message.receive_v1') return false;

  const { message, sender } = envelope.event;
  if (message.message_type !== 'text') return false;
  if (sender.sender_type === 'app') return false;

  const senderId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? '';
  const text = extractText(message.content, message.mentions ?? []);
  if (!text) return false;

  const selfId = await botOpenId();
  if (selfId && senderId === selfId) return false;

  if (message.chat_type === 'group') {
    const mentioned = (message.mentions ?? []).some((mention) => mention.id === selfId);
    if (!mentioned && !text.startsWith('/')) return false;
  }

  memory().remember({
    source: 'lark',
    chatId: message.chat_id,
    userId: senderId,
    role: 'user',
    text,
  });

  const commandReply = await handleCommand(router, message.chat_id, text);
  if (commandReply !== null) {
    await send(message.message_id, message.chat_id, commandReply);
    memory().remember({
      source: 'lark',
      chatId: message.chat_id,
      userId: 'assistant',
      role: 'assistant',
      text: commandReply,
    });
    return true;
  }

  const context = memory().context(message.chat_id, text);
  const input = context ? `${context}\n\nUser: ${text}` : text;

  try {
    const result = await router.run({ input });
    const header = `[${result.brain}${result.model ? ` · ${result.model}` : ''} · ${result.latencyMs}ms]`;
    const reply = `${result.output || '(no output)'}\n\n${header}`;
    await send(message.message_id, message.chat_id, reply);
    memory().remember({
      source: 'lark',
      chatId: message.chat_id,
      userId: 'assistant',
      role: 'assistant',
      text: result.output ?? '',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await send(message.message_id, message.chat_id, `All brains failed: ${detail}`);
    memory().remember({
      source: 'lark',
      chatId: message.chat_id,
      userId: 'assistant',
      role: 'assistant',
      text: `error: ${detail}`,
    });
  }

  return true;
}

export function larkAppId(): string {
  return larkCredentials().appId;
}
