/** Prompt-safety helpers for untrusted ticket text (local copies; this package does not import workflow). */

/**
 * Replaces anything imitating a delimiter or trusted header with an inert marker: operator-note markers (as in
 * the workflow), reference/untrusted block delimiters, and any `<<<` / `>>>` runs.
 */
export function neutralizeMarkers(text: string): string {
  return text
    .replace(/<<<\s*OPERATOR\s+NOTE/gi, '[removed operator-section marker]').replace(/OPERATOR\s+NOTE[^\n]{0,200}?>>>/gi, '[removed operator-section marker]')
    .replace(/^[ \t]*#+[ \t]*(?:Operator\b[^\n]*\(\s*trusted|Revision context\b|Reference\b[^\n]*\buntrusted)[^\n]*$/gim, '[removed operator-section marker]')
    .replace(/<<<+\s*(?:[A-Za-z]+\b)?/g, '[removed marker]')
    .replace(/\b(?:REFERENCE|UNTRUSTED|CANDIDATE|TICKET|OPERATOR)\b[^\n]{0,200}?>>>+/gi, '[removed marker]')
    .replace(/>>>+/g, '> > >')
    .replace(/\bid=[0-9a-f]{32}\b/gi, 'id=[removed]');
}

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a character; appends a marker when cut. */
export function truncateBytes(text: string, maxBytes: number, marker = '\n[truncated]'): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const room = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let lo = 0; let hi = text.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (Buffer.byteLength(text.slice(0, mid)) <= room) lo = mid; else hi = mid - 1; }
  let cut = text.slice(0, lo);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}${marker}`;
}

/** Collapses whitespace to one line (for headings and list items). */
export const oneLine = (text: string, max = 300): string => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
