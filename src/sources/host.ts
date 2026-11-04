/** Minimal Host and Context interfaces connecting Source plugins to the application. */
import type { ChannelRef, OutboundMessage, Thread, ThreadFact, Trigger } from './core-types.js'

/** Health status reported by a source kind. */
export interface Health {
  state: 'starting' | 'ready' | 'paused' | 'error'
  detail: string
  at?: string
  code?: string
  values?: Record<string, string>
}

export function health(state: Health['state'], code: string, values: Record<string, string> = {}): Health {
  return { state, detail: code, code, ...Object.keys(values).length ? { values } : {} }
}

/** SourceContext provides the surface a Source kind needs to read, send, and manage state. */
export interface SourceContext {
  /** Executes a lark-cli command and returns its stdout. */
  commands: { lark(argv: string[]): Promise<string> }
  /** True once the Source is fully configured and ready to poll. */
  configured(): boolean
  /** Ingests a trigger into the Engine; returns whether work was scheduled. */
  receive(trigger: Trigger): Promise<void>
  /** Reports health for one of the source kind's declared health entries. */
  report(entry: string, health: Health): void
  /** Returns the source's current configuration, or undefined when disabled. */
  config<C>(): C | undefined
  /** Source-scoped KV: set a value (pass undefined to delete). */
  set<T>(key: string, value: T | undefined): void
  /** Source-scoped KV: get a value. */
  get<T>(key: string): T | undefined
  /** Manage Threads: describe display info, patch metadata. */
  threads: {
    /** Subscribed threads for a given source. */
    subscribed(source: string): { key: string; meta: Record<string, unknown>; createdAt: string; lastAt?: string }[]
    /** Describe a thread with label, URL, facts. */
    describe(key: string, desc: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void
    /** Patch thread metadata. */
    patch(key: string, meta: Record<string, unknown>): void
    /** Get a thread by key. */
    get(key: string): { key: string; meta: Record<string, unknown>; createdAt: string } | undefined
  }
  /** Manage tickets. */
  tickets: {
    get(id: string): { id: string } | undefined
    open(): { id: string }[]
  }
}
