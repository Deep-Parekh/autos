import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { ERROR_CODES } from './errors.js';
import { identifierSchema, issueKeySchema, jobIdSchema, modelSchema, providerSchema, roleSchema } from './domain.js';

const localPath = z.string().min(1).refine((path) => isAbsolute(path) && !/[\x00\r\n]/.test(path), 'Expected an absolute local path');
export const providerRequestSchema = z.strictObject({
  job_id: jobIdSchema, issue_key: issueKeySchema, provider: providerSchema, role: roleSchema,
  model: modelSchema.optional(), cwd: localPath, prompt_path: localPath, transcript_path: localPath,
  timeout_ms: z.number().int().positive().max(3_600_000), source_access: z.enum(['read', 'write']), auth_profile: identifierSchema,
}).refine((request) => request.role === 'swe' || request.source_access === 'read', 'QA and reviewer require source-read access');

export const providerResultSchema = z.strictObject({
  provider: providerSchema, role: roleSchema, status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  exit_code: z.number().int().nullable(), elapsed_ms: z.number().nonnegative(), transcript_path: localPath,
  result: z.unknown(), error_code: z.enum(ERROR_CODES).optional(), model: z.string().optional(),
}).superRefine((result, ctx) => {
  if (result.status === 'SUCCEEDED' && (result.exit_code !== 0 || result.error_code)) ctx.addIssue({ code: 'custom', message: 'Successful provider invocation requires zero exit and no error' });
  if (result.status === 'TIMED_OUT' && result.error_code !== 'TIMEOUT') ctx.addIssue({ code: 'custom', message: 'Timeout requires TIMEOUT error' });
  if (result.status === 'CANCELLED' && result.error_code !== 'CANCELLED') ctx.addIssue({ code: 'custom', message: 'Cancellation requires CANCELLED error' });
});

/**
 * Repository instruction files honoured for every role and provider, read from the checked-out commit.
 * Matching is on repository-relative paths: any-depth basenames, or fixed directories.
 */
export const INSTRUCTION_FILE_BASENAMES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;
export const INSTRUCTION_FILE_PATTERNS = [
  '**/AGENTS.md', '**/CLAUDE.md', '**/GEMINI.md', '.github/copilot-instructions.md',
  '.github/instructions/**/*.instructions.md', '.cursor/rules/**/*.mdc', '.claude/rules/**/*.md',
] as const;
/** Agents may not create, modify, delete or rename instruction files; a candidate touching one is refused (FORBIDDEN). */
export const INSTRUCTION_FILES_IMMUTABLE = true;

/**
 * Reserved, never-committed workspace directory where the SWE keeps its progress checklist so a fallback provider
 * can continue after a limit failure. Excluded from candidates, digests and commits; removed by trusted code
 * before checks, QA, review and commit. Its content is agent-written, untrusted data.
 */
export const HANDOFF_DIR = '.autos-handoff';
export const HANDOFF_FILE = '.autos-handoff/progress.md';
export const HANDOFF_MAX_BYTES = 16 * 1024;

/**
 * How a provider profile authenticates (provider-profiles.json `mode`, required).
 * - subscription: the seat's plan, never API pricing. claude: CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`;
 *   codex: a `codex login` (ChatGPT) auth.json directory; cursor: a CURSOR_API_KEY user key (usage follows the account's plan).
 *   API-key variables are refused in this mode, because Claude Code prefers an API key over the subscription token.
 * - api: pay-per-token keys (ANTHROPIC_API_KEY / OPENAI_API_KEY).
 * - local: an operator-run model endpoint (claude: ANTHROPIC_BASE_URL [+ ANTHROPIC_AUTH_TOKEN]); codex/cursor not yet supported.
 */
export const PROVIDER_AUTH_MODES = ['subscription', 'api', 'local'] as const;
export type ProviderAuthMode = typeof PROVIDER_AUTH_MODES[number];
/** One configured profile entry as reported by supervisor health (never secrets or paths). */
export interface ProviderAuthSummary { profile: string; provider: 'claude' | 'codex' | 'cursor'; mode: ProviderAuthMode }
