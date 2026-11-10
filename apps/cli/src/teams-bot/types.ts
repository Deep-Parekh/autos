/**
 * Shared types for the two-way Teams bot (`autos teams bot`). Every chunk of docs/teams-bot-plan.md builds against
 * these; change them only through the primary agent.
 *
 * Trust model: an inbound HTTP request is untrusted until auth.ts has verified its Bot Framework JWT. Even then the
 * activity body is untrusted user input: it is parsed with `activitySchema`, the sender must be in
 * `teams_bot.allowed_users`, and command text / card submits are parsed by commands.ts into `BotCommand`.
 */
import { z } from 'zod';
import type { AgentRole } from '@autos/contracts';

/** Subset of a Bot Framework Activity that the bot reads. Unknown fields are dropped. */
export const activitySchema = z.object({
  type: z.string().min(1).max(64),
  id: z.string().max(512).optional(),
  serviceUrl: z.string().max(2048),
  channelId: z.string().max(64),
  from: z.object({ id: z.string().max(512), name: z.string().max(256).optional(), aadObjectId: z.string().max(64).optional() }),
  conversation: z.object({ id: z.string().min(1).max(1024), conversationType: z.string().max(64).optional(), tenantId: z.string().max(64).optional() }),
  recipient: z.object({ id: z.string().max(512), name: z.string().max(256).optional() }).optional(),
  replyToId: z.string().max(512).optional(),
  text: z.string().max(40_000).optional(),
  /** Card button data (Action.Submit). Parse with commands.ts `parseCardSubmit`. */
  value: z.unknown().optional(),
  channelData: z.object({ tenant: z.object({ id: z.string().max(64) }).optional() }).optional(),
});
export type Activity = z.infer<typeof activitySchema>;

/** Where to send a message: taken from a verified inbound activity. */
export interface ConversationRef { serviceUrl: string; conversationId: string; tenantId?: string | undefined }

/** One outgoing message: plain text, an Adaptive Card, or both. */
export interface OutgoingMessage { text?: string; card?: AdaptiveCard }
/** An Adaptive Card 1.4 object ({ type: 'AdaptiveCard', version: '1.4', body, actions }). */
export type AdaptiveCard = Record<string, unknown>;

export type RoleNotes = Partial<Record<AgentRole, string>>;

/** A command from an allowed Teams user, after parsing and validation. */
export type BotCommand =
  | { kind: 'help' }
  | { kind: 'run_form'; issueKey?: string }
  | { kind: 'status' }
  | { kind: 'show'; issueKey: string }
  | { kind: 'run'; issueKey: string; dryRun: boolean; notes: RoleNotes }
  | { kind: 'note'; issueKey: string; notes: RoleNotes; hold: boolean }
  | { kind: 'release'; issueKey: string }
  | { kind: 'revise'; issueKey: string; note: string; roles: AgentRole[] }
  | { kind: 'retry'; jobId: string }
  | { kind: 'cancel'; jobId: string; confirmed: boolean }
  | { kind: 'close'; issueKey: string; resolution: 'merged' | 'abandoned'; confirmed: boolean };

export type ParseResult = { ok: true; command: BotCommand } | { ok: false; message: string };

/** What the parser needs to validate a command. */
export interface ParseContext { allowedProjects: readonly string[]; jiraSiteUrl: string; maxNoteChars: number }

/**
 * Data carried by every Action.Submit button and form in cards.ts and read by commands.ts `parseCardSubmit`.
 * `autos: 'v1'` marks Autos' own cards. Free-text inputs (note, swe, qa, reviewer, issue) arrive as strings.
 */
export const CARD_ACTIONS = ['run', 'revise', 'retry', 'cancel', 'close', 'show', 'status', 'run_form'] as const;
export const cardSubmitSchema = z.object({
  autos: z.literal('v1'),
  action: z.enum(CARD_ACTIONS),
  /** Issue key or Jira browse link (form input) */
  issue: z.string().max(2048).optional(),
  job_id: z.string().max(64).optional(),
  note: z.string().max(40_000).optional(),
  swe: z.string().max(40_000).optional(),
  qa: z.string().max(40_000).optional(),
  reviewer: z.string().max(40_000).optional(),
  /** Input.Toggle values arrive as 'true' / 'false' strings. */
  dry_run: z.enum(['true', 'false']).optional(),
  resolution: z.enum(['merged', 'abandoned']).optional(),
  confirmed: z.boolean().optional(),
});
export type CardSubmit = z.infer<typeof cardSubmitSchema>;
