import type { AgentRole } from '@autos/contracts';
import {
  cardSubmitSchema,
  type BotCommand,
  type CardSubmit,
  type ParseContext,
  type ParseResult,
  type RoleNotes,
} from './types.js';

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ['swe', 'qa', 'reviewer'] as const satisfies readonly AgentRole[];
type NoteRole = (typeof ROLES)[number] | 'all';

function clean(input: string): string {
  return input
    .replace(/<at\b[^>]*>[\s\S]*?<\/at\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .split('\n').map((line) => line.replace(/[\t\r ]+/g, ' ').trim()).join('\n').trim();
}

function refusal(reason: string, input = ''): ParseResult {
  const sample = clean(input).replace(/\s+/g, ' ').slice(0, 40);
  return { ok: false, message: sample ? `${reason}: “${sample}”` : reason };
}

function notesFromText(text: string, ctx: ParseContext): RoleNotes | null {
  // parseCommandText cleans the full message before splitting it into command
  // arguments. Do not run the HTML pass again here: decoded entities such as
  // `&lt;fix&gt;` are now literal user text and must remain intact.
  const cleaned = text.trim();
  if (!cleaned) return null;
  const result: RoleNotes = {};
  const chunks: Record<NoteRole, string[]> = { swe: [], qa: [], reviewer: [], all: [] };
  for (const line of cleaned.split('\n')) {
    const prefix = /^(swe|qa|reviewer|all):\s*/i.exec(line);
    if (prefix) {
      const current = prefix[1]!.toLowerCase() as NoteRole;
      chunks[current].push(line.slice(prefix[0].length));
    } else {
      chunks.swe.push(line);
    }
  }
  for (const role of ROLES) {
    const parts = [...chunks[role], ...chunks.all].filter(Boolean);
    if (!parts.length) continue;
    const note = parts.join('\n').trim();
    if (note.length > ctx.maxNoteChars) return null;
    result[role] = note;
  }
  return Object.keys(result).length ? result : null;
}

function extractKey(input: string, ctx: ParseContext): string | null {
  const value = input.trim();
  let key: string;
  if (/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(value)) {
    key = value.toUpperCase();
  } else {
    let url: URL;
    let site: URL;
    try { url = new URL(value); site = new URL(ctx.jiraSiteUrl); } catch { return null; }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.host.toLowerCase() !== site.host.toLowerCase()) return null;
    const match = /^\/browse\/([^/]+)$/.exec(url.pathname);
    if (!match) return null;
    try { key = decodeURIComponent(match[1]!).toUpperCase(); } catch { return null; }
  }
  if (!ISSUE_KEY.test(key)) return null;
  const project = key.slice(0, key.lastIndexOf('-'));
  return ctx.allowedProjects.some((allowed) => allowed.toUpperCase() === project) ? key : null;
}

export function extractIssueKey(input: string, ctx: ParseContext): string | null {
  return extractKey(input, ctx);
}

function requiredKey(input: string, ctx: ParseContext): string | null {
  return extractKey(input, ctx);
}

function toRunNotes(fields: Pick<CardSubmit, 'swe' | 'qa' | 'reviewer'>, ctx: ParseContext): RoleNotes | null | 'too_long' {
  const notes: RoleNotes = {};
  for (const role of ROLES) {
    const value = fields[role];
    if (value === undefined || !clean(value)) continue;
    const note = clean(value);
    if (note.length > ctx.maxNoteChars) return 'too_long';
    notes[role] = note;
  }
  return Object.keys(notes).length ? notes : null;
}

export function parseCommandText(text: string, ctx: ParseContext): ParseResult {
  const input = clean(text);
  if (!input) return refusal('Type help to see available commands');
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input)!;
  const verb = match[1]!.toLowerCase();
  const rest = match[2] ?? '';
  const args = rest.trim();
  const words = args ? args.split(/\s+/) : [];
  const keyCommand = (kind: 'show' | 'release', usage: string): ParseResult => {
    const key = requiredKey(words[0] ?? '', ctx);
    return key && words.length === 1 ? { ok: true, command: kind === 'show' ? { kind, issueKey: key } : { kind, issueKey: key } } : refusal(usage, args);
  };
  switch (verb) {
    case 'help': return args ? refusal('Usage: help', input) : { ok: true, command: { kind: 'help' } };
    case 'run': {
      if (!args) return { ok: true, command: { kind: 'run_form' } };
      const key = requiredKey(words[0] ?? '', ctx);
      if (!key) return refusal('Usage: run KEY [dry run|--dry-run] [notes]', args);
      let tail = args.slice((words[0] ?? '').length).trim();
      let dryRun = false;
      const dry = /^(?:dry\s+run|--dry-run)(?:\s+|$)/i.exec(tail);
      if (dry) { dryRun = true; tail = tail.slice(dry[0].length).trim(); }
      const notes = tail ? notesFromText(tail, ctx) : null;
      if (tail && !notes) return refusal(`Notes exceed the ${ctx.maxNoteChars} character limit`, tail);
      return { ok: true, command: { kind: 'run', issueKey: key, dryRun, notes: notes ?? {} } };
    }
    case 'status': return args ? refusal('Usage: status', input) : { ok: true, command: { kind: 'status' } };
    case 'show': return keyCommand('show', 'Usage: show KEY');
    case 'release': return keyCommand('release', 'Usage: release KEY');
    case 'note': {
      const key = requiredKey(words[0] ?? '', ctx);
      if (!key) return refusal('Usage: note KEY [role:] text [hold]', args);
      let body = args.slice((words[0] ?? '').length).trim();
      if (!body) return refusal('Usage: note KEY [role:] text [hold]', args);
      const hold = /(?:^|\s)hold\s*$/i.test(body);
      if (hold) body = body.replace(/(?:^|\s)hold\s*$/i, '').trim();
      const notes = notesFromText(body, ctx);
      if (!notes) return refusal(`Note must be 1–${ctx.maxNoteChars} characters`, body);
      return { ok: true, command: { kind: 'note', issueKey: key, notes, hold } };
    }
    case 'revise': {
      const key = requiredKey(words[0] ?? '', ctx);
      if (!key) return refusal('Usage: revise KEY [roles swe,qa] text', args);
      let body = args.slice((words[0] ?? '').length).trim();
      let roles: AgentRole[] = ['swe'];
      const roleMatch = /^roles\s+(\S+)(?:\s+|$)/i.exec(body);
      if (roleMatch) {
        const requested = roleMatch[1]!.split(',').map((role) => role.trim().toLowerCase());
        if (!requested.length || requested.some((role) => !ROLES.includes(role as (typeof ROLES)[number]))) return refusal('Roles must be swe, qa, or reviewer', roleMatch[1]);
        roles = [...new Set(requested as AgentRole[])];
        body = body.slice(roleMatch[0].length).trim();
      }
      // `body` is part of the already-cleaned message (see notesFromText).
      const note = body.trim();
      if (!note || note.length > ctx.maxNoteChars) return refusal(`Revision note must be 1–${ctx.maxNoteChars} characters`, body);
      return { ok: true, command: { kind: 'revise', issueKey: key, note, roles } };
    }
    case 'retry':
    case 'cancel': {
      const jobId = words[0] ?? '';
      if (words.length !== 1 || !UUID.test(jobId)) return refusal(`Usage: ${verb} JOB_ID`, args);
      return { ok: true, command: verb === 'retry' ? { kind: 'retry', jobId: jobId.toLowerCase() } : { kind: 'cancel', jobId: jobId.toLowerCase(), confirmed: false } };
    }
    case 'close': {
      const key = requiredKey(words[0] ?? '', ctx);
      const resolution = words[1]?.toLowerCase();
      if (!key || words.length !== 2 || (resolution !== 'merged' && resolution !== 'abandoned')) return refusal('Usage: close KEY merged|abandoned', args);
      return { ok: true, command: { kind: 'close', issueKey: key, resolution, confirmed: false } };
    }
    default: return refusal('Unknown command; type help for commands', input);
  }
}

export function parseCardSubmit(value: unknown, ctx: ParseContext): ParseResult {
  const parsed = cardSubmitSchema.safeParse(value);
  if (!parsed.success) return refusal('This card is invalid');
  const data = parsed.data;
  const key = data.issue === undefined ? null : requiredKey(clean(data.issue), ctx);
  switch (data.action) {
    case 'status': return { ok: true, command: { kind: 'status' } };
    case 'run_form':
      if (data.issue !== undefined && !key) return refusal('Choose a valid Jira issue');
      return key ? { ok: true, command: { kind: 'run_form', issueKey: key } } : { ok: true, command: { kind: 'run_form' } };
    case 'show': return key ? { ok: true, command: { kind: 'show', issueKey: key } } : refusal('Choose a valid Jira issue');
    case 'run': {
      if (!key) return refusal('Choose a valid Jira issue');
      const notes = toRunNotes(data, ctx);
      if (notes === 'too_long') return refusal(`Notes exceed the ${ctx.maxNoteChars} character limit`);
      return { ok: true, command: { kind: 'run', issueKey: key, dryRun: data.dry_run === 'true', notes: notes ?? {} } };
    }
    case 'revise': {
      if (!key) return refusal('Choose a valid Jira issue');
      const note = clean(data.note ?? '');
      if (!note || note.length > ctx.maxNoteChars) return refusal(`Revision note must be 1–${ctx.maxNoteChars} characters`, note);
      return { ok: true, command: { kind: 'revise', issueKey: key, note, roles: ['swe'] } };
    }
    case 'retry':
    case 'cancel': {
      if (!data.job_id || !UUID.test(data.job_id)) return refusal('Choose a valid job');
      return data.action === 'retry'
        ? { ok: true, command: { kind: 'retry', jobId: data.job_id.toLowerCase() } }
        : { ok: true, command: { kind: 'cancel', jobId: data.job_id.toLowerCase(), confirmed: data.confirmed === true } };
    }
    case 'close': {
      if (!key || !data.resolution) return refusal('Choose a valid issue and close resolution');
      return { ok: true, command: { kind: 'close', issueKey: key, resolution: data.resolution, confirmed: data.confirmed === true } };
    }
  }
}
