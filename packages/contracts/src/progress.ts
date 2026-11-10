import { z } from 'zod';
import { sanitizeTranscriptTarget, transcriptActionsFromLine, type TranscriptAction } from './transcript.js';

/**
 * Live agent progress: what an agent is doing while a role runs, built only from its tool calls (never from what it
 * says). Labels are agent-produced, untrusted data: they are sanitized and bounded here and must be treated as display
 * text only. Progress is best effort and informational; it never changes job state.
 */
export const PROGRESS_KINDS = ['command', 'read', 'edit', 'search', 'other'] as const;
export const progressKindSchema = z.enum(PROGRESS_KINDS);
export type ProgressKind = z.infer<typeof progressKindSchema>;

export const PROGRESS_LABEL_MAX = 200;
/** No control characters (incl. line separators) so a label can never forge another line. */
// eslint-disable-next-line no-control-regex
const labelSchema = z.string().min(1).max(PROGRESS_LABEL_MAX).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/);

export const progressActionSchema = z.strictObject({ kind: progressKindSchema, label: labelSchema });
export type ProgressAction = z.infer<typeof progressActionSchema>;

/** An action plus how many earlier actions were folded into it by throttling. */
export const progressUpdateSchema = z.strictObject({
  kind: progressKindSchema,
  label: labelSchema,
  skipped: z.number().int().min(0).max(1_000_000),
});
export type ProgressUpdate = z.infer<typeof progressUpdateSchema>;

/**
 * Wire format between the worker entrypoint (stderr) and the supervisor: one JSON object per line,
 * `{"autos_progress":{"kind":…,"label":…,"skipped":…}}`, at most PROGRESS_LINE_MAX_BYTES. Anything else on stderr is
 * not progress.
 */
export const PROGRESS_LINE_MAX_BYTES = 1024;
export const progressLineSchema = z.strictObject({ autos_progress: progressUpdateSchema });
export type ProgressLine = z.infer<typeof progressLineSchema>;

export function formatProgressLine(update: ProgressUpdate): string {
  return JSON.stringify({ autos_progress: update });
}

/** Parses one stderr line; null unless it is a valid, bounded progress line. Never throws. */
export function parseProgressLine(line: string): ProgressUpdate | null {
  try {
    if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > PROGRESS_LINE_MAX_BYTES) return null;
    const trimmed = line.trim();
    if (!trimmed.startsWith('{"autos_progress"')) return null;
    const parsed = progressLineSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data.autos_progress : null;
  } catch {
    return null;
  }
}

const COMMAND_TOOLS = new Set(['command', 'bash', 'shell', 'run_terminal_cmd', 'terminal', 'exec_command', 'local_shell']);
const READ_TOOLS = new Set(['read', 'read_file', 'view', 'notebookread', 'cat']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'edit_file', 'write_file', 'apply_patch', 'delete', 'delete_file', 'search_replace', 'str_replace']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'ls', 'list_dir', 'search', 'codebase_search', 'file_search', 'grep_search', 'find']);
const SHELL_WRAPPERS = /^(?:\S*\/)?(?:bash|sh|zsh|dash)\s+(?:-[a-z]*c[a-z]*)\s+(.+)$/s;
const COMMAND_TOKENS = 3; // the executable plus at most two arguments

function kindOf(tool: string): ProgressKind {
  const name = tool.toLowerCase();
  if (name === 'file_change' || name.startsWith('file_change:')) return 'edit';
  if (COMMAND_TOOLS.has(name)) return 'command';
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (SEARCH_TOOLS.has(name)) return 'search';
  return 'other';
}

function unquote(text: string): string {
  const t = text.trim();
  // The scrubber may have eaten a closing quote (for example after a URL), so only the opening one is required.
  if (t[0] === '"' || t[0] === "'") return t.endsWith(t[0]) && t.length >= 2 ? t.slice(1, -1) : t.slice(1);
  return t;
}

/** The executable (basename) plus at most two arguments of a command line; `bash -lc "…"` and leading `cd x &&` are unwrapped. */
export function commandLabel(command: string): string {
  let text = sanitizeTranscriptTarget(command);
  for (let i = 0; i < 2; i++) {
    const wrapped = SHELL_WRAPPERS.exec(text);
    if (!wrapped?.[1]) break;
    text = unquote(wrapped[1]);
  }
  const segments = text.split(/\s*(?:&&|\|\||;)\s*/).map((part) => part.trim()).filter(Boolean);
  const main = segments.find((part) => !/^cd(?:\s|$)/.test(part)) ?? segments[0] ?? '';
  const tokens = main.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 'command';
  tokens[0] = tokens[0]!.replace(/^.*\//, '') || tokens[0]!;
  const label = tokens.slice(0, COMMAND_TOKENS).join(' ');
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

function pathLabel(target: string): string {
  if (!target) return '';
  // Workspace paths arrive relative (sanitizeTranscriptTarget strips /workspace/); other absolute paths keep only the name.
  return target.startsWith('/') ? target.replace(/^.*\//, '') : target;
}

function safeLabel(text: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
  const bounded = clean.length > PROGRESS_LABEL_MAX ? `${clean.slice(0, PROGRESS_LABEL_MAX - 1)}…` : clean;
  return bounded || fallback;
}

/** Maps one extracted transcript action to a progress action. Never throws. */
export function progressFromTranscriptAction(action: TranscriptAction): ProgressAction {
  const kind = kindOf(action.tool);
  if (kind === 'command') return { kind, label: safeLabel(commandLabel(action.target), 'command') };
  if (kind === 'read' || kind === 'edit') return { kind, label: safeLabel(pathLabel(action.target), action.tool) };
  if (kind === 'search') return { kind, label: safeLabel(action.target ? `${action.tool} ${pathLabel(action.target)}` : action.tool, action.tool) };
  return { kind, label: safeLabel(action.tool, 'tool') };
}

/**
 * Progress actions of one provider stream line (claude/cursor stream-json, codex exec --json); [] for narrative,
 * results and anything unrecognised. Pass the same `seen` set for every line of one session. Never throws.
 */
export function progressFromLine(line: string, seen: Set<string>): ProgressAction[] {
  try {
    return transcriptActionsFromLine(line, seen).map(progressFromTranscriptAction);
  } catch {
    return [];
  }
}

export interface ProgressThrottleOptions {
  /** Minimum time between two emitted updates. */
  intervalMs: number;
  /** Stop emitting after this many updates (later actions are dropped). */
  maxUpdates?: number;
  emit: (update: ProgressUpdate) => void;
  now?: () => number;
}

/**
 * Rate-limits progress: the first action is emitted at once; actions inside the interval are held, and when the
 * interval ends the latest held action is emitted with `skipped` = the number of actions folded into it. `close()`
 * cancels the pending timer without emitting. A throwing `emit` is swallowed.
 */
export class ProgressThrottle {
  private last = Number.NEGATIVE_INFINITY;
  private held: ProgressAction | undefined;
  private heldSkipped = 0;
  private emitted = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly options: ProgressThrottleOptions) {
    this.now = options.now ?? Date.now;
  }

  get count(): number { return this.emitted; }

  push(action: ProgressAction, skipped = 0): void {
    if (this.closed || this.exhausted()) return;
    const elapsed = this.now() - this.last;
    if (this.held === undefined && elapsed >= this.options.intervalMs) {
      this.send({ ...action, skipped });
      return;
    }
    if (this.held !== undefined) this.heldSkipped += 1;
    this.heldSkipped += skipped;
    this.held = action;
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), Math.max(0, this.options.intervalMs - elapsed));
      this.timer.unref?.();
    }
  }

  /** Emits the held action now (if any). */
  flush(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.closed || this.held === undefined) return;
    const update: ProgressUpdate = { ...this.held, skipped: this.heldSkipped };
    this.held = undefined; this.heldSkipped = 0;
    if (!this.exhausted()) this.send(update);
  }

  close(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    this.held = undefined;
    this.closed = true;
  }

  private exhausted(): boolean {
    return this.options.maxUpdates !== undefined && this.emitted >= this.options.maxUpdates;
  }

  private send(update: ProgressUpdate): void {
    this.last = this.now();
    this.emitted += 1;
    try { this.options.emit(update); } catch { /* progress is best effort */ }
  }
}
