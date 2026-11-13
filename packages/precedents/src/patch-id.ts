import { createHash, type Hash } from 'node:crypto';

/**
 * `git patch-id --stable` computed in-process for patch text (for example Autos' `changes.patch`, whose commit is not
 * in any mirror), so it can be compared with patch-ids of mirror commits. A port of git's builtin/patch-id.c
 * (get_one_patchid, stable mode, SHA-1 repositories): whitespace-insensitive per-file hashes, summed with carry.
 * Returns null when the text contains no diff.
 */
export function stablePatchId(patch: string | Uint8Array): string | null {
  // Bytes are mapped 1:1 through latin1 so non-UTF-8 content hashes exactly as git sees it.
  const encoding: BufferEncoding = typeof patch === 'string' ? 'utf8' : 'latin1';
  const text = typeof patch === 'string' ? patch : Buffer.from(patch).toString('latin1');
  const result = new Uint8Array(20);
  let hash: Hash = createHash('sha1');
  const flush = () => {
    const h = hash.digest(); hash = createHash('sha1');
    let carry = 0;
    for (let i = 0; i < 20; i++) { carry += (result[i] ?? 0) + (h[i] ?? 0); result[i] = carry & 0xff; carry >>= 8; }
  };
  let patchlen = 0; let before = -1; let after = -1; let binary = false;
  let pre = ''; let post = '';
  const lines = text.split(/(?<=\n)/);
  for (const line of lines) {
    if (line.startsWith('\\ ') && line.length > 12) continue;
    const p = line.startsWith('commit ') ? line.slice(7) : line.startsWith('From ') ? line.slice(5) : line;
    if (/^[0-9a-f]{40}/.test(p)) { if (patchlen) break; continue; }
    if (!patchlen && !line.startsWith('diff ')) continue;
    if (before === -1) {
      if (line.startsWith('GIT binary patch') || line.startsWith('Binary files')) {
        binary = true; before = 0;
        hash.update(Buffer.from(pre, encoding)); hash.update(Buffer.from(post, encoding)); flush();
        continue;
      } else if (line.startsWith('index ')) {
        const dots = line.indexOf('..');
        if (dots >= 0) {
          let end = line.indexOf(' ', dots); if (end < 0) end = line.length - 1;
          pre = line.slice(6, dots).slice(0, 64); post = line.slice(dots + 2, end).slice(0, 64);
        }
        continue;
      } else if (line.startsWith('--- ')) { before = 1; after = 1; }
      else if (!/^[A-Za-z]/.test(line)) break;
    }
    if (binary) { if (line.startsWith('diff ')) { binary = false; before = -1; } continue; }
    if (before === 0 && after === 0) {
      if (line.startsWith('@@ -')) { const h = scanHunkHeader(line); before = h.before; after = h.after; continue; }
      if (!line.startsWith('diff ')) break;
      flush(); before = -1; after = -1;
    }
    if (line[0] === '-' || line[0] === ' ') before--;
    if (line[0] === '+' || line[0] === ' ') after--;
    const stripped = Buffer.from(line.replace(/[ \t\n\r]/g, ''), encoding);
    patchlen += stripped.length;
    hash.update(stripped);
  }
  flush();
  return patchlen ? Buffer.from(result).toString('hex') : null;
}

/** Hunk line counts from `@@ -a,b +c,d @@` (numbers other than the counts are ignored), as git's scan_hunk_header. */
function scanHunkHeader(line: string): { before: number; after: number } {
  const digits = (s: string) => /^[0-9]*/.exec(s)?.[0].length ?? 0;
  let q = line.slice(4); let n = digits(q); let before = 1; let after = 1;
  if (q[n] === ',') { q = q.slice(n + 1); before = Number.parseInt(q, 10) || 0; n = digits(q); }
  if (n === 0 || q[n] !== ' ' || q[n + 1] !== '+') return { before, after };
  let r = q.slice(n + 2); n = digits(r);
  if (r[n] === ',') { r = r.slice(n + 1); after = Number.parseInt(r, 10) || 0; }
  return { before, after };
}
