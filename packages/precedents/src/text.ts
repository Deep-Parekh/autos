import { createHash } from 'node:crypto';
import type { IndexedComment, IndexedIssue } from '@autos/contracts';

/**
 * Deterministic text processing for the precedent index (plan §3.2): secret redaction, per-project template
 * stripping, corpus stoplist, defect-statement extraction, error signatures, code identifiers and chunking.
 * Everything here is pure and local; nothing calls a model or the network.
 */

/** Bump when processing changes so every issue is re-chunked (only changed chunks are re-embedded). */
export const PROCESSING_VERSION = 1;

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// Redaction

const REDACTIONS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_KEY]'],
  [/\b(proxy-authorization|authorization)(\s*[:=]\s*)(?:(bearer|basic|token|digest|negotiate)\s+)?[^\s,;'"]+/gi,
    (_m, header: string, sep: string, scheme: string | undefined) => `${header}${sep}${scheme ? `${scheme} ` : ''}[REDACTED]`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 [REDACTED]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@'],
  [/\b(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>)]*/gi, '$1?[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ATATT[A-Za-z0-9_=-]{20,}|sk-[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,})/g, '[REDACTED_TOKEN]'],
  [/\b((?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|private[_-]?key|access[_-]?token|auth[_-]?token|token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  // Long mixed-case alphanumeric runs with several digits look like keys; plain hex SHAs (lowercase only) are kept.
  [/\b(?=[A-Za-z0-9_+-]*[A-Z])(?=[A-Za-z0-9_+-]*[a-z])(?=(?:[A-Za-z_+-]*[0-9]){3})[A-Za-z0-9_+-]{40,}={0,2}/g, '[REDACTED_SECRET]'],
];

/** Removes tokens, auth headers, URL credentials and query strings, key=value secrets and email addresses. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement as (...m: string[]) => string);
  return out;
}

/** Redacts every free-text field of an issue (summary, description, comment bodies). */
export function redactIssue(issue: IndexedIssue): IndexedIssue {
  return { ...issue, summary: redactSecrets(issue.summary), description: redactSecrets(issue.description), comments: issue.comments.map((c) => ({ ...c, body: redactSecrets(c.body) })) };
}

// ---------------------------------------------------------------------------------------------------------------
// Template learning and stripping

export interface ProjectTemplate { project: string; lines: string[]; hash: string }

/** Normalizes a line for template comparison: markup, case, digits and trailing colons do not matter. */
export function normalizeTemplateLine(line: string): string {
  return line.toLowerCase().replace(/^\s*(?:h[1-6]\.\s*|[#>*_\-|•\s]+)*/, '').replace(/[*_]+/g, '').replace(/[*_|\s:：]+$/, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Learns one project's boilerplate: normalized lines present in more than `minFraction` of its descriptions
 * (headings such as "Steps to reproduce", environment table rows, signatures). Needs `minDocs` descriptions.
 */
export function learnTemplates(project: string, descriptions: string[], opts: { minFraction?: number; minDocs?: number } = {}): ProjectTemplate {
  const minFraction = opts.minFraction ?? 0.2; const minDocs = opts.minDocs ?? 5;
  const counts = new Map<string, number>();
  if (descriptions.length >= minDocs) {
    for (const d of descriptions) {
      const seen = new Set(d.split(/\r?\n/).map(normalizeTemplateLine).filter((l) => l.length >= 2 && l.length <= 200));
      for (const l of seen) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
  }
  return templateFromLines(project, [...counts].filter(([, n]) => n / descriptions.length > minFraction && n >= 2).map(([l]) => l));
}

/** Builds a template (with its content hash) from stored normalized lines. */
export function templateFromLines(project: string, lines: string[]): ProjectTemplate {
  const sorted = [...new Set(lines)].sort();
  return { project, lines: sorted, hash: sorted.length ? sha256(sorted.join('\n')).slice(0, 16) : '' };
}

/** Removes template lines (by normalized form) from a text. */
export function stripTemplates(text: string, template: ProjectTemplate | null | undefined): string {
  if (!template || !template.lines.length) return text;
  const set = new Set(template.lines);
  return text.split(/\r?\n/).filter((l) => !set.has(normalizeTemplateLine(l))).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens and corpus stoplist

const ENGLISH_STOPWORDS = new Set(('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its '
  + 'me my no not of on or our she so than that the their them then there these they this to too was we were what when where which who why will with '
  + 'would you your also any all after before again just only should please see get got via per out up down new now one two still other some such very').split(' '));

/** Tokenizes like SQLite FTS5 unicode61: letters/digits runs, lowercased. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []);
}

export interface TermStats {
  doc_count: number;
  /** Terms excluded from keyword candidate generation (very common across the corpus, or one project's jargon). */
  stoplist: Set<string>;
  df: Map<string, number>;
}

export interface TermStatsOptions {
  /** Global document-frequency fraction above which a term is a stopword (default 0.1). */
  maxDfFraction?: number;
  /** Per-project fraction above which a term is that project's jargon (default 0.3, projects with >= minProjectDocs). */
  projectDfFraction?: number;
  minProjectDocs?: number;
  /** Corpora smaller than this get only the built-in English stopwords (default 20). */
  minDocs?: number;
}

/** Computes document frequencies over all issues and derives the corpus stoplist (plan §3.2 item 2). */
export function computeTermStats(docs: Array<{ project: string; text: string }>, opts: TermStatsOptions = {}): TermStats {
  const maxDf = opts.maxDfFraction ?? 0.1; const projDf = opts.projectDfFraction ?? 0.3; const minProjectDocs = opts.minProjectDocs ?? 10; const minDocs = opts.minDocs ?? 20;
  const df = new Map<string, number>();
  const perProject = new Map<string, { n: number; df: Map<string, number> }>();
  for (const d of docs) {
    const terms = new Set(tokenize(d.text));
    const p = perProject.get(d.project) ?? { n: 0, df: new Map<string, number>() }; p.n++; perProject.set(d.project, p);
    for (const t of terms) { df.set(t, (df.get(t) ?? 0) + 1); p.df.set(t, (p.df.get(t) ?? 0) + 1); }
  }
  const stoplist = new Set<string>(ENGLISH_STOPWORDS);
  if (docs.length >= minDocs) {
    for (const [t, n] of df) if (n / docs.length > maxDf) stoplist.add(t);
    for (const p of perProject.values()) if (p.n >= minProjectDocs) for (const [t, n] of p.df) if (n / p.n > projDf) stoplist.add(t);
  }
  return { doc_count: docs.length, stoplist, df };
}

/** Rare, non-stop query terms for FTS5 (rarest first, capped). */
export function keywordTerms(text: string, stats: TermStats | null, max = 24): string[] {
  const stop = stats?.stoplist ?? ENGLISH_STOPWORDS;
  const terms = [...new Set(tokenize(text))].filter((t) => t.length >= 3 && !stop.has(t) && !ENGLISH_STOPWORDS.has(t) && !/^\d+$/.test(t));
  const df = (t: string) => stats?.df.get(t) ?? 0;
  return terms.sort((a, b) => df(a) - df(b) || a.localeCompare(b)).slice(0, max);
}

/** Builds a safe FTS5 MATCH expression: every term double-quoted (quotes doubled), OR-joined. Returns null when empty. */
export function ftsMatchExpression(terms: string[]): string | null {
  const quoted = terms.filter((t) => t.length > 0).map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.length ? quoted.join(' OR ') : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Error signatures

export type ErrorSignatureKind = 'exception' | 'error_code' | 'http' | 'stack' | 'log';
export interface ErrorSignature {
  kind: ErrorSignatureKind;
  /** Exact-match key, e.g. `exc:OrderPricingException`, `http:500 /api/orders/{id}`, `stack:<hash>`. */
  key: string;
  /** Weak keys (generic exceptions, bare HTTP status) never count as an evidence signal on their own. */
  strong: boolean;
  /** Short human-readable form for prompts and explain output. */
  display: string;
}

const GENERIC_EXCEPTIONS = new Set(['Exception', 'Error', 'RuntimeException', 'NullPointerException', 'IllegalStateException', 'IllegalArgumentException',
  'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'IOException', 'UnsupportedOperationException', 'IndexOutOfBoundsException',
  'ArrayIndexOutOfBoundsException', 'ClassCastException', 'NumberFormatException', 'ValueError', 'KeyError', 'AttributeError', 'AssertionError',
  'ExecutionException', 'InvocationTargetException', 'UndeclaredThrowableException', 'ServletException', 'WebApplicationException']);

const FRAMEWORK_PREFIXES = ['java.', 'javax.', 'jakarta.', 'jdk.', 'sun.', 'com.sun.', 'org.springframework.', 'org.apache.', 'org.hibernate.', 'io.netty.',
  'org.junit.', 'kotlin.', 'scala.', 'reactor.', 'org.eclipse.jetty.', 'com.fasterxml.', 'io.undertow.', 'org.glassfish.'];

function normalizeJavaFrame(frame: string): string {
  return frame.replace(/\$\$(?:EnhancerBy|FastClassBy)\w*?\$\$[0-9a-f]+/g, '').replace(/\$\$Lambda\$?[\d/x]*(?:0x[0-9a-f]+)?/g, '$$Lambda')
    .replace(/lambda\$(\w+)\$\d+/g, 'lambda$$$1').replace(/\$\d+/g, '$$N').replace(/GeneratedMethodAccessor\d+/g, 'GeneratedMethodAccessor');
}
function normalizeScriptPath(path: string): string {
  const clean = path.replace(/^(?:webpack:\/\/\/?|file:\/\/\/?|https?:\/\/[^/]+)/, '').replace(/[?#].*$/, '');
  const base = clean.split('/').pop() ?? clean;
  return base.replace(/\.[0-9a-f]{6,}(?=\.)/g, '');
}

interface Frame { text: string; app: boolean }
function stackFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of text.split(/\r?\n/)) {
    const java = /^\s*at\s+([\w$.<>]+)\(([^)]*)\)\s*$/.exec(line);
    if (java?.[1] && /\.(?:java|kt|scala|groovy)(?::\d+)?$|Native Method|Unknown Source/.test(java[2] ?? '')) {
      const name = normalizeJavaFrame(java[1]);
      frames.push({ text: name, app: !FRAMEWORK_PREFIXES.some((p) => name.startsWith(p)) });
      continue;
    }
    const js = /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?((?:[a-z]+:\/\/\/?)?[^\s()]+?):\d+(?::\d+)?\)?\s*$/.exec(line);
    if (js?.[2]) {
      const path = js[2];
      const fn = (js[1] ?? '<anonymous>').replace(/^Object\./, '').replace(/\s*\[as \w+\]$/, '');
      frames.push({ text: `${fn}@${normalizeScriptPath(path)}`, app: !/node_modules|node:internal|^internal\//.test(path) });
      continue;
    }
    const py = /^\s*File "([^"]+)", line \d+, in (\S+)/.exec(line);
    if (py?.[1] && py[2]) frames.push({ text: `${normalizeScriptPath(py[1])}:${py[2]}`, app: !/site-packages|\/lib\/python/.test(py[1]) });
  }
  return frames;
}

/** Normalizes an endpoint: no scheme/host/query, ids replaced by `{id}`, lowercase. */
export function normalizeEndpoint(raw: string): string | null {
  let path = raw.replace(/^https?:\/\/[^/\s]+/i, '').replace(/[?#].*$/, '').replace(/[),.;:'"]+$/, '');
  if (!path.startsWith('/')) return null;
  path = path.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || (/^[0-9a-f]{8,}$/i.test(seg) && /\d/.test(seg))
      || (seg.length > 12 && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg)) || seg === '[REDACTED]') return '{id}';
    return seg.toLowerCase();
  }).join('/').replace(/\/+$/, '');
  return path.length > 1 ? path.slice(0, 200) : null;
}

const HTTP_STATUS_CONTEXT = /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s*code)?|returns?|returned|responds?|responded|response|error|code|failed with)\s*[:=(]?\s*([45]\d\d)\b|\b([45]\d\d)\s+(?:Internal Server Error|Bad Request|Not Found|Forbidden|Unauthorized|Conflict|Bad Gateway|Service Unavailable|Gateway Time-?out|Too Many Requests|Unprocessable Entity)/i;
const ENDPOINT = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(https?:\/\/[^\s"'<>]+|\/[A-Za-z0-9_.~{}\-/[\]]+)|(https?:\/\/[^\s"'<>]+)|(?<![\w./])(\/(?:api|rest|v\d+|graphql|services?|ws)\/[A-Za-z0-9_.~{}\-/[\]]*)/i;

/** Normalizes a log line to a template: timestamps, uuids, hex, numbers and quoted values replaced. */
export function logTemplate(line: string): string {
  return line
    .replace(/^\s*\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<ts>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/"[^"\n]{0,200}"|'[^'\n]{0,200}'/g, '<str>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\[[^\]]*<n>[^\]]*\]/g, '[<thread>]')
    .replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200);
}

/** Extracts exact-match error signatures from free text (plan §3.2 item 4). Deduplicated, deterministic order. */
export function extractErrorSignatures(text: string): ErrorSignature[] {
  const out = new Map<string, ErrorSignature>();
  const add = (s: ErrorSignature) => { if (!out.has(s.key)) out.set(s.key, s); };
  // Exception class names (qualified or simple).
  for (const m of text.matchAll(/\b((?:[a-z_$][\w$]*\.)*)([A-Z][\w$]*(?:Exception|Error|Fault))\b/g)) {
    const simple = m[2] ?? ''; if (simple.length < 6) continue;
    add({ kind: 'exception', key: `exc:${simple}`, strong: !GENERIC_EXCEPTIONS.has(simple), display: simple });
  }
  // Error codes: well-known prefixes and UPPER_SNAKE constants that name a failure.
  for (const m of text.matchAll(/\b((?:ORA|SQLSTATE|ERR|DB2|SQL|MSG|E|ERROR|CODE)[-_ ]?\d{3,6})\b/g)) {
    const code = (m[1] ?? '').toUpperCase().replace(/[ _]/g, '-');
    add({ kind: 'error_code', key: `code:${code}`, strong: true, display: code });
  }
  for (const m of text.matchAll(/\berror\s*(?:code)?\s*[:#=]\s*([A-Z][A-Z0-9_-]{2,40}\d[A-Z0-9_-]*|[A-Z]+(?:_[A-Z0-9]+)+)\b/g)) add({ kind: 'error_code', key: `code:${m[1]}`, strong: true, display: m[1] ?? '' });
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:ERROR|FAILED|FAILURE|NOT_FOUND|INVALID|DENIED|TIMEOUT|EXCEEDED|REJECTED|MISMATCH))\b/g)) add({ kind: 'error_code', key: `code:${m[1]}`, strong: true, display: m[1] ?? '' });
  // HTTP status + normalized endpoint, per line.
  for (const line of text.split(/\r?\n/)) {
    const st = HTTP_STATUS_CONTEXT.exec(line); if (!st) continue;
    const status = st[1] ?? st[2] ?? '';
    const ep = ENDPOINT.exec(line);
    const endpoint = ep ? normalizeEndpoint(ep[2] ?? ep[3] ?? ep[4] ?? '') : null;
    if (endpoint) add({ kind: 'http', key: `http:${status} ${endpoint}`, strong: true, display: `HTTP ${status} ${endpoint}` });
    else add({ kind: 'http', key: `http:${status}`, strong: false, display: `HTTP ${status}` });
  }
  // Top 5 normalized stack frames (application frames preferred), line numbers stripped.
  const frames = stackFrames(text);
  const app = frames.filter((f) => f.app);
  const top = (app.length >= 2 ? app : frames).slice(0, 5).map((f) => f.text);
  if (top.length >= 2) add({ kind: 'stack', key: `stack:${sha256(top.join('\n')).slice(0, 32)}`, strong: true, display: top.join(' < ') });
  // Log message templates.
  for (const line of text.split(/\r?\n/)) {
    if (!/\b(?:ERROR|FATAL|SEVERE|CRITICAL)\b/.test(line) || /^\s*at\s/.test(line)) continue;
    const body = logTemplate(line.replace(/^.*?\b(?:ERROR|FATAL|SEVERE|CRITICAL)\b\s*/, ''));
    if (body.split(' ').filter((w) => /[a-z]{2,}/.test(w)).length < 3) continue;
    add({ kind: 'log', key: `log:${body}`, strong: true, display: body.slice(0, 120) });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// Code identifiers

export type CodeRefKind = 'path' | 'class' | 'method' | 'config' | 'table';
export interface CodeRef { kind: CodeRefKind; value: string }

const CODE_EXT = 'java|kt|scala|groovy|ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|cs|cpp|c|h|hpp|swift|xml|ya?ml|properties|sql|json|html|css|scss|vue|gradle|jsp|ftl';
const PATH_RE = new RegExp(`(?:^|[\\s"'(\\[=:,])((?:[\\w.-]+/)*[\\w-]+(?:\\.[\\w-]+)*\\.(?:${CODE_EXT}))(?=$|[\\s"'),:;\\]])`, 'gm');
const NOT_CLASSES = new Set(['JavaScript', 'TypeScript', 'GitHub', 'GitLab', 'PowerPoint', 'LinkedIn', 'YouTube', 'WordPress', 'PostgreSQL', 'MySQL', 'OAuth', 'iPhone', 'MacBook', 'SharePoint', 'OneDrive', 'WebSocket', 'DevOps', 'BitBucket', 'JetBrains', 'IntelliJ']);
const PACKAGE_ROOTS = new Set(['com', 'org', 'net', 'java', 'javax', 'jakarta', 'io', 'jdk', 'sun', 'de', 'uk', 'www']);
const DOMAIN_ENDINGS = new Set(['com', 'org', 'net', 'io', 'de', 'co', 'uk', 'gov', 'edu', 'info', 'local', 'internal', 'html', 'htm', ...CODE_EXT.replace('ya?ml', 'yml|yaml').split('|')]);

/** Extracts class/method names, file paths, dotted config keys and SQL table names (plan §3.2 item 5). */
export function extractCodeIdentifiers(text: string): CodeRef[] {
  const out = new Map<string, CodeRef>();
  const add = (kind: CodeRefKind, value: string) => { const v = value.trim(); if (v && v.length <= 300) out.set(`${kind}:${v}`, { kind, value: v }); };
  for (const m of text.matchAll(PATH_RE)) { const p = (m[1] ?? '').replace(/^\.\//, ''); if (!p.includes('://') && !/^\d/.test(p)) add('path', p); }
  for (const m of text.matchAll(/\b(?:[a-z_][\w]*\.)+([A-Z][A-Za-z0-9]+)\b/g)) if (m[1] && /[a-z]/.test(m[1]) && /[A-Z].*[A-Z]|^[A-Z][a-z]+[A-Z]?/.test(m[1]) && !NOT_CLASSES.has(m[1])) add('class', m[1]);
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g)) if (m[1] && m[1].length >= 6 && !NOT_CLASSES.has(m[1]) && /[a-z]/.test(m[1])) add('class', m[1]);
  // Exception/error classes are error signatures, not independent code evidence.
  for (const [k, r] of out) if (r.kind === 'class' && /(?:Exception|Error|Fault)$/.test(r.value)) out.delete(k);
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]+)[.#]([a-z][A-Za-z0-9]+)\s*\(/g)) add('method', `${m[1]}.${m[2]}`);
  for (const m of text.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*)\s*\(/g)) if (m[1]) add('method', m[1]);
  for (const m of text.matchAll(/(?<![\w./-])([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){2,})(?![\w/-])/g)) {
    const key = m[1] ?? ''; const parts = key.split('.');
    if (PACKAGE_ROOTS.has(parts[0] ?? '') || DOMAIN_ENDINGS.has(parts[parts.length - 1] ?? '')) continue;
    add('config', key);
  }
  for (const m of text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`"]?(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]{2,})/g)) if (m[1] && !/^(?:SELECT|WHERE|SET|VALUES)$/i.test(m[1])) add('table', m[1].toLowerCase());
  return [...out.values()];
}

const GENERIC_BASENAMES = new Set(['index', 'main', 'app', 'utils', 'util', 'common', 'config', 'constants', 'types', 'test', 'helpers', 'helper', 'base', 'application', 'pom', 'package', 'readme', 'build', 'settings']);
const basename = (p: string) => (p.split('/').pop() ?? p);
const stem = (p: string) => basename(p).replace(/\.[^.]+$/, '');

/**
 * Overlap between ticket code refs and candidate paths/fix files: exact path, path suffix, or a class name /
 * distinctive basename equal to a file's basename. Returns the matched candidate paths (deduplicated).
 */
export function codeOverlap(refs: CodeRef[], candidatePaths: string[]): string[] {
  const matched = new Set<string>();
  const queryPaths = refs.filter((r) => r.kind === 'path').map((r) => r.value.toLowerCase());
  const classes = new Set(refs.filter((r) => r.kind === 'class').map((r) => r.value.toLowerCase()));
  for (const cand of candidatePaths) {
    const c = cand.toLowerCase(); const cStem = stem(c);
    if (queryPaths.some((q) => q === c || c.endsWith(`/${q}`) || q.endsWith(`/${c}`) || (basename(q) === basename(c) && !GENERIC_BASENAMES.has(stem(q)) && stem(q).length >= 6))) matched.add(cand);
    else if (classes.has(cStem) && !GENERIC_BASENAMES.has(cStem)) matched.add(cand);
  }
  return [...matched];
}

/** Refs as candidate "paths" for overlap: paths as-is, class names as `<Class>.<ext-less>` stems. */
export function refsAsPaths(refs: CodeRef[]): string[] {
  return refs.filter((r) => r.kind === 'path' || r.kind === 'class').map((r) => r.value);
}

// ---------------------------------------------------------------------------------------------------------------
// Defect statement

export interface DefectStatement { observed: string; expected: string; where: string; errors: string[]; text: string }

type Section = 'observed' | 'expected' | 'where' | 'steps' | 'error' | 'other';
const HEADINGS: Array<[Section, RegExp]> = [
  ['expected', /^expected(?:\s+(?:results?|behaviou?r|outcome))?$/i],
  ['observed', /^(?:(?:actual|observed|current)(?:\s+(?:results?|behaviou?r|outcome))?|(?:problem|issue|bug|defect)(?:\s+description)?|description|what happened|symptoms?)$/i],
  ['where', /^(?:environment|env|where|location|module|screen|page|component|url|endpoint|affected\s+(?:areas?|modules?|components?))$/i],
  ['steps', /^(?:steps(?:\s+to\s+reproduce)?|reproduction(?:\s+steps)?|how\s+to\s+reproduce|repro)$/i],
  ['error', /^(?:errors?|stack\s*trace|logs?|exception|error\s+message|log\s+output)$/i],
  ['other', /^(?:notes?|workaround|additional\s+(?:info|information|context)|attachments?|acceptance\s+criteria|root\s+cause|analysis|impact)$/i],
];
function headingOf(line: string): { section: Section; rest: string } | null {
  const m = /^\s*(?:#{1,6}\s*|h[1-6]\.\s*)?[*_]{0,2}\s*([A-Za-z][A-Za-z /&()-]{1,40}?)\s*[*_]{0,2}\s*(?:[:：]\s*[*_]{0,2}\s*(.*))?$/.exec(line);
  if (!m?.[1]) return null;
  const label = m[1].trim();
  for (const [section, re] of HEADINGS) if (re.test(label)) return { section, rest: (m[2] ?? '').trim() };
  return null;
}

const OBSERVED_RE = /\b(?:fails?|failed|failing|failure|errors?|exception|crash(?:es|ed)?|throws?|thrown|returns?\s+(?:an?\s+)?(?:\d{3}|null|empty|wrong|blank|nothing)|cannot|can't|can not|unable|does not|doesn't|did not|didn't|is not|isn't|not working|broken|wrong|incorrect|missing|hangs?|freez\w*|nothing happens|no effect|not (?:shown|displayed|saved|updated|sent|visible)|time[sd]? ?out|stuck|duplicat\w*|blank|instead)\b/i;
const EXPECTED_RE = /\b(?:should|expected|expect|supposed to|must)\b/i;
const WHERE_RE = /\b(?:on|in|at|from|under)\s+(?:the\s+)?((?:[A-Z][\w-]*\s+){0,3}[A-Za-z][\w-]*)\s+(screen|page|tab|dialog|module|report|job|endpoint|service|api|form|view|menu|wizard|batch)\b/g;

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sentences = (text: string) => text.split(/\r?\n/).flatMap((l) => l.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter((s) => s.length >= 8 && !/^\s*at\s/.test(s));

/**
 * Deterministic defect statement (plan §3.2 item 3): observed, expected, where and error evidence from headings
 * first, then sentence patterns. Compact (<= maxChars, default 1200). Templates are stripped from section bodies.
 */
export function extractDefectStatement(input: { summary: string; description: string; comments?: string[] }, template?: ProjectTemplate | null, maxChars = 1200): DefectStatement {
  const sections: Record<Section, string[]> = { observed: [], expected: [], where: [], steps: [], error: [], other: [] };
  let current: Section | null = null; const free: string[] = [];
  const tset = new Set(template?.lines ?? []);
  for (const line of input.description.split(/\r?\n/)) {
    const h = headingOf(line);
    if (h) { current = h.section; if (h.rest) sections[current].push(h.rest); continue; }
    if (tset.has(normalizeTemplateLine(line))) continue;
    if (current) sections[current].push(line); else free.push(line);
  }
  const freeText = [free.join('\n'), ...(input.comments ?? [])].join('\n');
  let observed = sections.observed.join(' ').trim();
  let expected = sections.expected.join(' ').trim();
  const freeSentences = sentences(freeText);
  if (!observed) observed = freeSentences.filter((s) => OBSERVED_RE.test(s) && !/^\s*(?:expected|should)\b/i.test(s)).slice(0, 4).join(' ');
  if (!expected) expected = freeSentences.filter((s) => EXPECTED_RE.test(s)).slice(0, 2).join(' ');
  const all = [input.summary, input.description, ...(input.comments ?? [])].join('\n');
  const whereParts = new Set<string>(sections.where.join(' ').trim() ? [sections.where.join(' ').trim()] : []);
  for (const m of all.matchAll(WHERE_RE)) whereParts.add(`${m[1]} ${m[2]}`);
  const refs = extractCodeIdentifiers(all).filter((r) => r.kind === 'path' || r.kind === 'class').slice(0, 4).map((r) => r.value);
  const errs = extractErrorSignatures(all);
  for (const s of errs) if (s.kind === 'http' && s.strong) whereParts.add(s.display.replace(/^HTTP \d+ /, ''));
  for (const r of refs) whereParts.add(r);
  const where = [...whereParts].join('; ');
  const errors = errs.map((s) => s.display).slice(0, 8);
  const parts = [`Summary: ${clip(input.summary, 200)}`];
  if (observed) parts.push(`Observed: ${clip(observed, 420)}`);
  if (expected) parts.push(`Expected: ${clip(expected, 250)}`);
  if (where) parts.push(`Where: ${clip(where, 160)}`);
  if (errors.length) parts.push(`Errors: ${clip(errors.join('; '), 300)}`);
  const text = parts.join('\n').slice(0, maxChars);
  return { observed: clip(observed, 420), expected: clip(expected, 250), where: clip(where, 160), errors, text };
}

/** Rule-based "describes a defect" score in [0,1] (a soft ranking feature, never a filter). */
export function defectScore(input: { summary: string; defect: DefectStatement; signatures: ErrorSignature[] }): number {
  let s = 0;
  if (input.signatures.some((x) => x.strong)) s += 0.35; else if (input.signatures.length) s += 0.15;
  if (input.defect.observed) s += 0.25;
  if (input.defect.expected) s += 0.15;
  if (/\b(?:bug|error|fail\w*|broken|crash\w*|wrong|incorrect|not working|exception|issue|regression|defect|cannot|can't|unable)\b/i.test(input.summary)) s += 0.25;
  return Math.min(1, s);
}

// ---------------------------------------------------------------------------------------------------------------
// Chunks and issue preparation

export const CHUNK_KINDS = ['defect', 'head', 'comment', 'error', 'fix'] as const;
export type ChunkKind = typeof CHUNK_KINDS[number];
/** Chunk kinds that get vectors (KNN runs on defect statements and head chunks only). */
export const EMBEDDED_CHUNK_KINDS: readonly ChunkKind[] = ['defect', 'head'];
export interface ChunkDraft { kind: ChunkKind; ord: number; text: string; hash: string }

const HEAD_WORDS = 300; // ~400 tokens
const HEAD_OVERLAP = 40;
const COMMENT_HEAD = 5; const COMMENT_TAIL = 30; const COMMENT_MAX_CHARS = 2000;

/** Human (non-app) comments capped to the first 5 and last 30. */
export function selectComments(comments: IndexedComment[]): IndexedComment[] {
  const human = comments.filter((c) => !c.author_is_app && c.body.trim());
  return human.length <= COMMENT_HEAD + COMMENT_TAIL ? human : [...human.slice(0, COMMENT_HEAD), ...human.slice(-COMMENT_TAIL)];
}

/** Splits text into overlapping word windows (~400 tokens each). */
export function splitWords(text: string, size = HEAD_WORDS, overlap = HEAD_OVERLAP): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= size) return words.length ? [words.join(' ')] : [];
  const out: string[] = [];
  for (let start = 0; start < words.length; start += size - overlap) { out.push(words.slice(start, start + size).join(' ')); if (start + size >= words.length) break; }
  return out;
}

export interface FixSummary { commit_sha: string; subject: string; files: string[] }

export interface PreparedIssue {
  /** Redacted issue, as stored. */
  issue: IndexedIssue;
  content_hash: string;
  defect: DefectStatement;
  /** Defect statement built without comments (judge and prompt use; comments never enter prompts). */
  defect_public: string;
  /** Description with project templates stripped (head chunks, prompt excerpts). */
  description_clean: string;
  signatures: ErrorSignature[];
  code_refs: CodeRef[];
  defect_score: number;
  chunks: ChunkDraft[];
}

const chunk = (kind: ChunkKind, ord: number, text: string): ChunkDraft => ({ kind, ord, text, hash: sha256(`${kind}\n${text}`) });

/** Processes one issue exactly as both the indexer and the query side do. */
export function prepareIssue(raw: IndexedIssue, ctx: { template?: ProjectTemplate | null; fixes?: FixSummary[] } = {}): PreparedIssue {
  const issue = redactIssue(raw);
  const template = ctx.template ?? null;
  const comments = selectComments(issue.comments);
  const commentBodies = comments.map((c) => c.body.slice(0, COMMENT_MAX_CHARS));
  const description_clean = stripTemplates(issue.description, template).replace(/\n{3,}/g, '\n\n').trim();
  const defect = extractDefectStatement({ summary: issue.summary, description: issue.description, comments: commentBodies }, template);
  const defect_public = extractDefectStatement({ summary: issue.summary, description: issue.description }, template).text;
  const allText = [issue.summary, issue.description, ...commentBodies].join('\n');
  const signatures = extractErrorSignatures(allText);
  const code_refs = extractCodeIdentifiers(allText);
  const chunks: ChunkDraft[] = [chunk('defect', 0, defect.text)];
  splitWords(`${issue.summary}\n${description_clean}`).forEach((t, i) => chunks.push(chunk('head', i, t)));
  commentBodies.forEach((b, i) => chunks.push(chunk('comment', i, b)));
  if (signatures.length) chunks.push(chunk('error', 0, signatures.map((s) => `${s.display} ${s.key}`).join('\n')));
  const fixes = (ctx.fixes ?? []).slice().sort((a, b) => a.commit_sha.localeCompare(b.commit_sha));
  if (fixes.length) chunks.push(chunk('fix', 0, fixes.map((f) => `${f.subject}\n${f.files.join('\n')}`).join('\n').slice(0, 4000)));
  const { updated_at: _ignored, ...stable } = issue;
  const content_hash = sha256(JSON.stringify({ v: PROCESSING_VERSION, t: template?.hash ?? '', issue: stable, fixes }));
  return { issue, content_hash, defect, defect_public, description_clean, signatures, code_refs, defect_score: defectScore({ summary: issue.summary, defect, signatures }), chunks };
}
