import { cp, lstat, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

// Excerpt budget (characters). The contract caps output_excerpt at 12,000, so these plus markers stay below it.
const HEAD_LIMIT = 3_000;
const TAIL_LIMIT = 6_500;
const KEY_LIMIT = 1_800;
const KEY_LINE_LIMIT = 240;
const KEY_PATTERN = /ERROR|FAIL|Tests run|BUILD FAILURE|Exception/;
const HANDOFF_DIR = '.autos-handoff';

function value(argv, key) {
  const index = argv.indexOf(key);
  if (index < 0 || !argv[index + 1]) throw new Error('invalid request');
  return argv[index + 1];
}

/** Keeps the first and last output plus the most informative middle lines, and says when output was dropped. */
function createExcerpt() {
  let head = '';
  let tail = '';
  let full = '';
  let total = 0;
  let carry = '';
  const key = [];
  let keyChars = 0;
  let keySkipped = false;
  const noteLine = (line) => {
    if (!KEY_PATTERN.test(line)) return;
    const clipped = line.length > KEY_LINE_LIMIT ? `${line.slice(0, KEY_LINE_LIMIT)}...` : line;
    if (keyChars + clipped.length + 1 > KEY_LIMIT) { keySkipped = true; return; }
    key.push(clipped);
    keyChars += clipped.length + 1;
  };
  return {
    add(label, chunk) {
      const text = `[${label}] ${chunk.toString('utf8')}`;
      total += text.length;
      if (full.length <= HEAD_LIMIT + TAIL_LIMIT) full += text;
      if (head.length < HEAD_LIMIT) {
        const take = text.slice(0, HEAD_LIMIT - head.length);
        head += take;
      }
      tail = (tail + text).slice(-TAIL_LIMIT);
      const lines = (carry + text).split('\n');
      carry = lines.pop() ?? '';
      if (carry.length > 4_000) carry = carry.slice(-4_000);
      for (const line of lines) noteLine(line);
    },
    finish() {
      if (carry) noteLine(carry);
      if (total <= HEAD_LIMIT + TAIL_LIMIT) return full;
      const tailStart = total - tail.length;
      const overlap = Math.max(0, head.length - tailStart);
      const tailText = tail.slice(overlap);
      const dropped = Math.max(0, total - head.length - tailText.length);
      const parts = [head, `\n[... ${dropped} characters of output truncated ...]\n`];
      if (key.length) parts.push(`[matching lines from the truncated middle${keySkipped ? ' (more omitted)' : ''}]\n${key.join('\n')}\n[... end of matching lines ...]\n`);
      parts.push(tailText);
      return parts.join('');
    },
  };
}

async function run(command, timeoutMs) {
  return await new Promise((resolvePromise) => {
    let child;
    let timedOut = false;
    const excerpt = createExcerpt();
    const env = { PATH: process.env.PATH ?? '', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' };
    if (existsSync('/opt/autos/m2/repository')) env.MAVEN_OPTS = '-Dmaven.repo.local=/opt/autos/m2/repository';
    try { child = spawn(command[0], command.slice(1), { cwd: '/scratch', env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolvePromise({ code: null, timedOut, output_excerpt: '[check process could not start]' }); return; }
    let stopped = false;
    let escalation;
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
      catch { try { child.kill(signal); } catch {} }
    };
    const timer = setTimeout(() => {
      if (stopped) return;
      stopped = true;
      timedOut = true;
      signalGroup('SIGTERM');
      escalation = setTimeout(() => signalGroup('SIGKILL'), 500);
      escalation.unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => excerpt.add('stdout', chunk));
    child.stderr.on('data', (chunk) => excerpt.add('stderr', chunk));
    child.on('error', () => { clearTimeout(timer); resolvePromise({ code: null, timedOut, output_excerpt: '[check process could not start]' }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      // A SIGKILL we did not send is almost always the kernel OOM killer: report it as exit 137.
      const killed = !timedOut && signal === 'SIGKILL';
      resolvePromise({ code: killed ? 137 : code, timedOut, output_excerpt: redact(`${excerpt.finish()}${killed ? '\n[check process was killed by SIGKILL]' : ''}`).slice(0, 12_000) });
    });
  });
}

function redact(text) {
  return text
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}

function gitFileList(source) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      // safe.directory: the read-only source is owned by the host autos user, not necessarily this container uid.
      child = spawn('git', ['-c', 'safe.directory=*', '-C', source, 'ls-files', '-co', '--exclude-standard', '-z'], {
        shell: false, stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH ?? '', HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', LANG: 'C.UTF-8' },
      });
    } catch { resolvePromise(undefined); return; }
    const chunks = [];
    let size = 0;
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size <= 64_000_000) chunks.push(chunk); });
    child.on('error', () => resolvePromise(undefined));
    child.on('close', (code) => resolvePromise(code === 0 && size <= 64_000_000 ? Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean) : undefined));
  });
}

function safeRelative(path) {
  return !path.startsWith('/') && !path.split('/').some((part) => part === '..' || part === '');
}

/**
 * Copies the source into the writable scratch directory without .git or the handoff directory.
 * When the source is a git checkout and git exists in the image, only tracked and untracked-but-not-ignored files
 * are copied, so build output and other ignored content never enters the scratch tree. Builds that read .git
 * metadata (for example git-describe version plugins) are unsupported: no .git is provided inside checks.
 */
async function copySource(source, scratch) {
  const listed = existsSync(join(source, '.git')) ? await gitFileList(source) : undefined;
  if (listed) {
    for (const path of listed) {
      if (!safeRelative(path) || path === HANDOFF_DIR || path.startsWith(`${HANDOFF_DIR}/`)) continue;
      const from = join(source, path);
      const to = join(scratch, path);
      let info;
      try { info = await lstat(from); } catch { continue; }
      await mkdir(dirname(to), { recursive: true });
      if (info.isDirectory()) { await mkdir(to, { recursive: true }); continue; }
      await cp(from, to, { dereference: false, errorOnExist: false, force: true });
    }
    return 'git';
  }
  const skip = [join(source, '.git'), join(source, HANDOFF_DIR)];
  await cp(source, scratch, {
    recursive: true, dereference: false,
    filter: (path) => !skip.includes(path) && !skip.some((root) => path.startsWith(`${root}${sep}`)) && !path.endsWith(`${sep}.git`),
  });
  return 'full';
}

try {
  const source = resolve(value(process.argv, '--source'));
  const scratch = resolve(value(process.argv, '--scratch'));
  const timeoutMs = Number(value(process.argv, '--timeout-ms'));
  const command = JSON.parse(value(process.argv, '--command-json'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 || !Array.isArray(command) || command.length < 1 || command.some((part) => typeof part !== 'string' || part.includes('\0'))) throw new Error('invalid request');
  await mkdir(scratch, { recursive: true });
  await copySource(source, scratch);
  const result = await run(command, timeoutMs);
  process.stdout.write(`${JSON.stringify({ exit_code: result.code, timed_out: result.timedOut, output_excerpt: result.output_excerpt })}\n`);
  process.exitCode = !result.timedOut && result.code === 0 ? 0 : 1;
} catch {
  // Exit 70 (EX_SOFTWARE) is this wrapper's own failure; 125-127 are reserved for Docker itself so the runner can tell them apart.
  process.stderr.write('check runner failed\n');
  process.exitCode = 70;
}
