/**
 * Persistent memory for the superagent.
 *
 * Uses Node's built-in SQLite (no native deps). Stores conversation turns,
 * durable facts, and processed event ids. Retrieval is a cheap hybrid of
 * keyword overlap and recency, which is good enough for chat context and
 * keeps the whole feature free and offline.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface MemoryMessage {
  id?: number;
  ts: string;
  source: string;
  chatId: string;
  userId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface MemoryFact {
  key: string;
  value: string;
  ts: string;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of',
  'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'do', 'does', 'did', 'can', 'could', 'will',
  'would', 'should', 'may', 'might', 'must', 'i', 'you', 'he', 'she', 'it',
  'we', 'they', 'me', 'my', 'your', 'our', 'their', 'this', 'that', 'these',
  'those', 'what', 'which', 'who', 'how', 'why', 'when', 'where', 'not',
  'no', 'yes', 'please', 'thanks', 'thank',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06ff]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function homeDir(): string {
  return process.env.BRAINSAIT_HOME ?? join(homedir(), '.brainsait');
}

export class MemoryStore {
  private db: DatabaseSync;

  constructor(path = process.env.MEMORY_DB ?? join(homeDir(), 'memory.db')) {
    mkdirSync(homeDir(), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        source TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id DESC);
      CREATE TABLE IF NOT EXISTS facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        ts TEXT NOT NULL
      );
    `);
  }

  remember(message: Omit<MemoryMessage, 'id' | 'ts'> & { ts?: string }): void {
    this.db
      .prepare(
        `INSERT INTO messages (ts, source, chat_id, user_id, role, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.ts ?? new Date().toISOString(),
        message.source,
        message.chatId,
        message.userId,
        message.role,
        message.text,
      );
  }

  recent(chatId?: string, limit = 10): MemoryMessage[] {
    const rows = chatId
      ? this.db
          .prepare(
            `SELECT id, ts, source, chat_id, user_id, role, text
             FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(chatId, limit)
      : this.db
          .prepare(
            `SELECT id, ts, source, chat_id, user_id, role, text
             FROM messages ORDER BY id DESC LIMIT ?`,
          )
          .all(limit);
    return (rows as Array<Record<string, unknown>>).map(rowToMessage).reverse();
  }

  /** Hybrid keyword + recency recall over the last N turns. */
  recall(query: string, limit = 6, chatId?: string): MemoryMessage[] {
    const terms = tokenize(query);
    if (terms.length === 0) return this.recent(chatId, limit);

    const rows = (chatId
      ? this.db
          .prepare(
            `SELECT id, ts, source, chat_id, user_id, role, text
             FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1000`,
          )
          .all(chatId)
      : this.db
          .prepare(
            `SELECT id, ts, source, chat_id, user_id, role, text
             FROM messages ORDER BY id DESC LIMIT 1000`,
          )
          .all()) as Array<Record<string, unknown>>;

    const scored = rows.map((row, index) => {
      const haystack = tokenize(String(row.text)).join(' ');
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 2;
      // Recency: newest row gets 1.0, oldest of the window gets ~0.
      score += 1 - index / Math.max(rows.length, 1);
      return { row, score };
    });

    return scored
      .filter((entry) => entry.score > 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => rowToMessage(entry.row));
  }

  addFact(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO facts (key, value, ts) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
      )
      .run(key, value, new Date().toISOString());
  }

  facts(limit = 10): MemoryFact[] {
    const rows = this.db
      .prepare(`SELECT key, value, ts FROM facts ORDER BY ts DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      key: String(row.key),
      value: String(row.value),
      ts: String(row.ts),
    }));
  }

  /** Returns true the first time an event id is seen, false on duplicates. */
  firstSeen(eventId: string): boolean {
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO events (event_id, ts) VALUES (?, ?)`)
      .run(eventId, new Date().toISOString());
    return Number(result.changes) > 0;
  }

  clear(chatId?: string): number {
    const result = chatId
      ? this.db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(chatId)
      : this.db.prepare(`DELETE FROM messages`).run();
    return Number(result.changes);
  }

  stats(): { messages: number; chats: number; facts: number; events: number } {
    const one = (sql: string): number =>
      Number((this.db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
    return {
      messages: one(`SELECT COUNT(*) AS n FROM messages`),
      chats: one(`SELECT COUNT(DISTINCT chat_id) AS n FROM messages`),
      facts: one(`SELECT COUNT(*) AS n FROM facts`),
      events: one(`SELECT COUNT(*) AS n FROM events`),
    };
  }

  /** Compact context block for prompt injection. */
  context(chatId: string, query: string): string {
    const parts: string[] = [];
    const facts = this.facts(8);
    if (facts.length) {
      parts.push(
        'Known facts:\n' +
          facts.map((fact) => `- ${fact.key}: ${fact.value}`).join('\n'),
      );
    }

    const relevant = this.recall(query, 6, chatId);
    if (relevant.length) {
      parts.push(
        'Relevant earlier conversation:\n' +
          relevant
            .map((msg) => `- ${msg.role}: ${msg.text.replace(/\s+/g, ' ').slice(0, 240)}`)
            .join('\n'),
      );
    }

    return parts.join('\n\n');
  }
}

function rowToMessage(row: Record<string, unknown>): MemoryMessage {
  return {
    id: Number(row.id),
    ts: String(row.ts),
    source: String(row.source),
    chatId: String(row.chat_id),
    userId: String(row.user_id),
    role: String(row.role) as MemoryMessage['role'],
    text: String(row.text),
  };
}

let shared: MemoryStore | null = null;

export function memory(): MemoryStore {
  if (!shared) shared = new MemoryStore();
  return shared;
}
