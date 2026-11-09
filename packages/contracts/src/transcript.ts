/**
 * Trusted, bounded summary of what a provider session did, derived from its private stream transcript (claude/cursor
 * stream-json, codex exec --json). Only tool names and their primary target (file path or truncated command) are
 * extracted; tool outputs, assistant text and reasoning are never returned. Targets are agent-produced, untrusted data.
 *
 * Supported event shapes (anything else is ignored):
 * - claude/cursor stream-json: `{"type":"assistant","message":{"content":[{"type":"tool_use","name":..,"input":{..}}]}}`
 * - cursor stream-json: `{"type":"tool_call","subtype":"started","tool_call":{"<name>ToolCall":{"args":{..}}}}` and
 *   `{"tool_call":{"function":{"name":..,"arguments":{..}|"<json>"}}}`
 * - codex exec --json: `item.started` / `item.completed` events with `item.type` of `command_execution`, `file_change`
 *   (one action per change) or `mcp_tool_call`; started/completed pairs of one item id are reported once.
 * Only text before a line that is exactly `[stderr]` is inspected, and only its last ~2 MB.
 */
export interface TranscriptAction { tool: string; target: string }
export const TRANSCRIPT_ACTION_LIMIT = 15;

const MAX_SCAN_CHARS = 2_000_000;
const MAX_LIMIT = 1000;
const MAX_TARGET_CHARS = 160;
const MAX_RAW_TARGET_CHARS = 4096;
const MAX_ARGUMENT_JSON_CHARS = 65_536;
const TOOL_PATTERN = /^[A-Za-z0-9_.:-]{1,40}$/;
const TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url'] as const;

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function sanitizeTool(value: unknown): string {
  return typeof value === 'string' && TOOL_PATTERN.test(value) ? value : 'tool';
}

/** Redacts and bounds an agent-produced target string. Exported for reuse; never throws. */
export function sanitizeTranscriptTarget(value: string): string {
  let text = value.slice(0, MAX_RAW_TARGET_CHARS)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.startsWith('/workspace/')) text = text.slice('/workspace/'.length);
  text = text
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g, '[url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)("[^"]*"?|'[^']*'?|[^\s"',;&]+)/gi, '$1$2[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
  if (text.length > MAX_TARGET_CHARS) {
    let cut = text.slice(0, MAX_TARGET_CHARS - 1);
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    text = `${cut}…`;
  }
  return text;
}

function targetFrom(input: unknown): string {
  const args = record(input);
  if (!args) return '';
  for (const key of TARGET_KEYS) {
    const value = args[key];
    if (typeof value === 'string') return key === 'url' ? '[url]' : sanitizeTranscriptTarget(value);
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string')) {
      return sanitizeTranscriptTarget((value as string[]).join(' '));
    }
  }
  return '';
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length > MAX_ARGUMENT_JSON_CHARS) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function claudeActions(event: Json, out: TranscriptAction[]): void {
  const content = record(event.message)?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const entry = record(block);
    if (entry?.type !== 'tool_use') continue;
    out.push({ tool: sanitizeTool(entry.name), target: targetFrom(entry.input) });
  }
}

function cursorToolCall(event: Json, out: TranscriptAction[]): void {
  if (event.subtype !== 'started') return;
  const call = record(event.tool_call);
  if (!call) return;
  for (const [key, value] of Object.entries(call)) {
    const body = record(value);
    if (!body) continue;
    if (key.endsWith('ToolCall') && key.length > 'ToolCall'.length) {
      out.push({ tool: sanitizeTool(key.slice(0, -'ToolCall'.length)), target: targetFrom(body.args) });
      return;
    }
    if (key === 'function') {
      out.push({ tool: sanitizeTool(body.name), target: targetFrom(parseArguments(body.arguments)) });
      return;
    }
  }
}

function codexActions(event: Json, seen: Set<string>, out: TranscriptAction[]): void {
  const item = record(event.item);
  if (!item || typeof item.type !== 'string') return;
  if (!['command_execution', 'file_change', 'mcp_tool_call'].includes(item.type)) return;
  const id = typeof item.id === 'string' || typeof item.id === 'number' ? `${item.type}:${String(item.id)}` : undefined;
  if (id === undefined) {
    if (event.type !== 'item.completed') return; // without an id only the completed event is counted
  } else {
    if (seen.has(id)) return;
    seen.add(id);
  }
  if (item.type === 'command_execution') {
    out.push({ tool: 'command', target: targetFrom({ command: item.command }) });
  } else if (item.type === 'file_change') {
    if (!Array.isArray(item.changes)) return;
    for (const change of item.changes) {
      const entry = record(change);
      if (!entry) continue;
      const kind = typeof entry.kind === 'string' && TOOL_PATTERN.test(`file_change:${entry.kind}`) ? `file_change:${entry.kind}` : 'file_change';
      out.push({ tool: kind, target: typeof entry.path === 'string' ? sanitizeTranscriptTarget(entry.path) : '' });
    }
  } else {
    out.push({ tool: sanitizeTool(item.tool), target: targetFrom(parseArguments(item.arguments)) });
  }
}

export function summarizeTranscriptActions(text: string, limit: number = TRANSCRIPT_ACTION_LIMIT): TranscriptAction[] {
  try {
    if (typeof text !== 'string') return [];
    const max = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(MAX_LIMIT, Math.max(0, Math.floor(limit))) : TRANSCRIPT_ACTION_LIMIT;
    if (max === 0) return [];
    let body = text;
    const stderrAt = body.startsWith('[stderr]\n') || body === '[stderr]' ? 0 : body.search(/\r?\n\[stderr\]\r?(?:\n|$)/);
    if (stderrAt >= 0) body = body.slice(0, stderrAt);
    if (body.length > MAX_SCAN_CHARS) {
      body = body.slice(-MAX_SCAN_CHARS);
      const firstNewline = body.indexOf('\n');
      body = firstNewline >= 0 ? body.slice(firstNewline + 1) : '';
    }
    const actions: TranscriptAction[] = [];
    const seen = new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('{') || line === '[transcript truncated]') continue;
      let event: Json | undefined;
      try { event = record(JSON.parse(line)); } catch { continue; }
      if (!event) continue;
      if (event.type === 'assistant') claudeActions(event, actions);
      else if (event.type === 'tool_call') cursorToolCall(event, actions);
      else if (event.type === 'item.started' || event.type === 'item.completed') codexActions(event, seen, actions);
      if (actions.length > max * 4) actions.splice(0, actions.length - max);
    }
    return actions.slice(-max);
  } catch {
    return [];
  }
}
