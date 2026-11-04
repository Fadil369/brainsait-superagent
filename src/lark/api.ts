/**
 * Minimal direct Lark/Feishu OpenAPI client.
 *
 * Talks to the OpenAPI with a tenant_access_token derived from the app
 * credentials, so it works without lark-cli, a logged-in user identity, or
 * the keychain. Only the handful of endpoints the bot needs are implemented.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LarkCredentials {
  appId: string;
  appSecret: string;
  brand: 'lark' | 'feishu';
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[1] && match[2] !== undefined) {
      out[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

export function larkCredentials(): LarkCredentials {
  const file = loadEnvFile(join(homedir(), '.secrets', 'lark.env'));
  const appId = process.env.LARK_APP_ID ?? file.LARK_APP_ID ?? '';
  const appSecret = process.env.LARK_APP_SECRET ?? file.LARK_APP_SECRET ?? '';
  const brand = (process.env.LARK_BRAND ?? file.LARK_BRAND ?? 'lark') as 'lark' | 'feishu';
  if (!appId || !appSecret) {
    throw new Error('Lark credentials missing (LARK_APP_ID / LARK_APP_SECRET)');
  }
  return { appId, appSecret, brand };
}

function baseUrl(brand: 'lark' | 'feishu'): string {
  return brand === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com';
}

export async function tenantToken(creds = larkCredentials()): Promise<string> {
  const cached = tokenCache.get(creds.appId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(`${baseUrl(creds.brand)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const body = (await res.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`Lark token failed: ${body.code ?? res.status} ${body.msg ?? ''}`);
  }
  tokenCache.set(creds.appId, {
    token: body.tenant_access_token,
    expiresAt: Date.now() + (body.expire ?? 7200) * 1000,
  });
  return body.tenant_access_token;
}

async function call<T>(
  path: string,
  init: RequestInit = {},
  creds = larkCredentials(),
): Promise<T> {
  const token = await tenantToken(creds);
  const res = await fetch(`${baseUrl(creds.brand)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json()) as { code?: number; msg?: string; data?: T } & T;
  if (!res.ok || (body.code !== undefined && body.code !== 0)) {
    throw new Error(`Lark API ${path} failed: ${body.code ?? res.status} ${body.msg ?? ''}`);
  }
  return (body.data ?? body) as T;
}

export interface LarkSendResult {
  message_id: string;
  chat_id?: string;
}

export async function sendText(chatId: string, text: string): Promise<LarkSendResult> {
  return call<LarkSendResult>(`/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
}

export async function replyText(messageId: string, text: string): Promise<LarkSendResult> {
  return call<LarkSendResult>(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
}

export interface LarkChat {
  chat_id: string;
  name?: string;
  chat_mode?: string;
  chat_type?: string;
}

export async function listChats(pageSize = 20): Promise<LarkChat[]> {
  const data = await call<{ items?: LarkChat[] }>(
    `/open-apis/im/v1/chats?page_size=${pageSize}`,
  );
  return data.items ?? [];
}

export async function createChat(name: string, description = ''): Promise<LarkChat> {
  return call<LarkChat>(`/open-apis/im/v1/chats`, {
    method: 'POST',
    body: JSON.stringify({ name, description, chat_mode: 'group', chat_type: 'private' }),
  });
}

export async function deleteChat(chatId: string): Promise<void> {
  await call(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
}

export async function botInfo(): Promise<{ open_id?: string; app_name?: string }> {
  return call<{ open_id?: string; app_name?: string }>(`/open-apis/bot/v3/info`);
}

/** Extracts plain text from a Lark message body and replaces mention keys. */
export function extractText(
  content: string,
  mentions: Array<{ key?: string; name?: string }> = [],
): string {
  let text = content;
  try {
    const parsed = JSON.parse(content) as { text?: string };
    if (typeof parsed.text === 'string') text = parsed.text;
  } catch {
    // Plain text content is fine.
  }
  for (const mention of mentions) {
    if (mention.key && mention.name) text = text.replaceAll(mention.key, `@${mention.name}`);
  }
  return text.replace(/@_user_\d+/g, '').trim();
}
