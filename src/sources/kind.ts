/**
 * SourceKind plugin contract: configuration schema, UI form fields, policy integration,
 * channel adapter, thread context reader, and search.
 * Adapted from @deepseek-ai/dsh-agent for standalone compilation.
 */
import type { z } from 'zod'
import type { OutboundMessage, ChannelRef, Trigger, ThreadFact } from './core-types.ts'
import type { SourceContext } from './host.ts'

/** Localized string pair (zh/en). */
export interface Localized { zh: string; en: string }

/** Configuration field specification. */
export type FieldSpec =
  | { key: string; type: 'switch'; label: Localized; hint?: Localized; advanced?: true }
  | { key: string; type: 'select'; label: Localized; hint?: Localized; advanced?: true; options: { value: string; label: Localized }[] }
  | { key: string; type: 'number'; label: Localized; hint?: Localized; advanced?: true; min: number; max: number }
  | { key: string; type: 'text'; label: Localized; hint?: Localized; advanced?: true; pattern?: string }
  | { key: string; type: 'rows'; label: Localized; hint?: Localized; columns: { key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean }[] }

/** Outbound messaging adapter for a source kind's threads. */
export interface SourceChannel {
  send(host: SourceContext, message: OutboundMessage): Promise<'sent' | 'gone'>
  link(address: Record<string, string>): { url: string; label: Localized }
}

/** Normalized message returned by thread context readers. */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string
}

/** Context part returned by thread context readers. */
export interface ContextPart {
  messages: ContextMessage[]
  next?: string
  status?: string
  body?: Record<string, unknown>
}

/** Bounded thread context reader for assessments. */
export interface ThreadContext<C = unknown> {
  /** The ID of the Trigger's own message among messages of its Thread. */
  messageId(trigger: Trigger): string
  /** Reads thread context for a trigger. */
  read(commands: SourceContext['commands'], trigger: Trigger, part: 'thread' | 'root' | 'parent', cursor: string | undefined, config: C): Promise<ContextPart>
}

/**
 * Pluggable source kind descriptor registered with SourceRegistry.
 * C is the resolved config type.
 */
export interface SourceKind<C = Record<string, unknown>> {
  kind: string
  title: Localized
  description: Localized
  /** Validates stored and submitted configuration. */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** Health entry names owned by this kind. */
  health: string[]
  /** Listening rule for a trigger of this kind. */
  scope?(input: { meta: Record<string, unknown> }, config: C): { listened: boolean; observed?: boolean; row?: string; reason?: string }
  /** Outbound reply adapter. */
  channel?: { send: (host: SourceContext, message: OutboundMessage) => Promise<'sent' | 'gone'>; link: (address: Record<string, string>) => { url: string; label: Localized } }
  /** Bounded context reader. */
  threadContext?: ThreadContext<C>
  /** Maps a search query to candidate Thread keys. */
  find?(query: string): { threads: string[]; terms: string[] }
  /** Returns the ID of the Trigger this one replies to. */
  repliesTo?(trigger: Trigger): string | undefined
  /** Policy section. */
  policy?: {
    schema: z.ZodType<Record<string, unknown>>
    fields: FieldSpec[]
    explicit: Localized
    rows?(config: Record<string, unknown>): { id: string; label: string | Localized; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }[]
  }
  /** Environment variables the kind registers. */
  environment?: {
    variables: { key: string; description: Localized }[]
    values(input: { deployment?: Record<string, unknown>; trigger?: Trigger }): Record<string, string>
  }
  /** Facts shown on the source card. */
  facts?(deployment: Record<string, unknown> | undefined): Record<string, Localized | string>
}
