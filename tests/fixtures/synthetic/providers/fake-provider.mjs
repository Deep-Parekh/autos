// Deterministic FAKE coding-provider process for the synthetic scenario. NOT provider certification:
// it only emits the output envelope that packages/cli-adapters accepts and never calls any model or network.
// Role is inferred from the workflow prompt text. Behaviour is fully deterministic.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const regressionSource = resolve(here, '../../java/src/test/java/example/tasks/CompleteTaskRegression.java');
const servicePath = 'src/main/java/example/tasks/TaskService.java';
const regressionPath = 'src/test/java/example/tasks/CompleteTaskRegression.java';
const FIX_LINE = '        task.setStatus("RESOLVED");';
const FOLLOW_UP = '        // Rationale: the action reports success only after the domain status is persisted as RESOLVED.';
const FAILS_ONCE = '[fixture:reviewer-fails-once]';
const NULL_GUARD_MARKER = '[fixture:operator-null-guard]';
const NULL_GUARD = '        if (task == null) throw new IllegalArgumentException("task");';
const QA_WRITES = '[fixture:qa-writes-source]';
const REVIEWER_WRITES = '[fixture:reviewer-writes-source]';

// Only text inside the workflow's trusted operator-note section counts: a header line naming the authenticated
// operator immediately followed by the <<<OPERATOR NOTE id=<nonce> ...>>> delimiters, where the header, opener and
// closer carry the same per-prompt nonce that the platform preamble declares. Marker text elsewhere is ignored.
function trustedOperatorNotes(prompt) {
  const declared = new Set([...prompt.matchAll(/"<<<OPERATOR NOTE id=([0-9a-f]{32})" and "OPERATOR NOTE id=\1>>>" \(exactly this id\)/g)].map((m) => m[1]));
  const pattern = /^## Operator [^\n]*\(trusted, from authenticated operator [^\n]*, id=([0-9a-f]{32})\)\n<<<OPERATOR NOTE id=\1 \(addressed to: [^)]*\)\n([\s\S]*?)\nOPERATOR NOTE id=\1>>>/gm;
  return [...prompt.matchAll(pattern)].filter((match) => declared.has(match[1])).map((match) => match[2]);
}
const operatorWantsNullGuard = (prompt) => trustedOperatorNotes(prompt).some((note) => note.includes(NULL_GUARD_MARKER));

function detectRole(prompt) {
  if (/Task: Implement the requested ticket/.test(prompt) || /Task: Repair the candidate/.test(prompt) || /Task: Repair the workspace/.test(prompt) || /Task: Apply the operator revision request/.test(prompt)) return 'swe';
  if (/Task: Assess this candidate/.test(prompt)) return 'qa';
  if (/Task: Review this exact candidate/.test(prompt)) return 'reviewer';
  return 'unknown';
}

function readIfPresent(path) { return existsSync(path) ? readFileSync(path, 'utf8') : ''; }

const HANDOFF_PATH = '.autos-handoff/progress.md';
function writeChecklist(cwd, { completed, inProgress = [], pending = [], notes }) {
  mkdirSync(join(cwd, '.autos-handoff'), { recursive: true });
  const list = (items) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- (none)');
  writeFileSync(join(cwd, HANDOFF_PATH), `## Completed\n${list(completed)}\n\n## In progress\n${list(inProgress)}\n\n## Pending\n${list(pending)}\n\n## Notes for a successor\n${notes}\n`);
}
function logAction(provider, issue, action, seen) {
  if (process.env.HOME && existsSync(process.env.HOME)) appendFileSync(join(process.env.HOME, 'actions.jsonl'), `${JSON.stringify({ provider, issue, action, handoff_checklist_seen: seen })}\n`);
}

// mode: 'full' (normal), 'partial' (service fix only; regression test left Pending).
function sweWork(cwd, prompt, provider, issue, mode = 'full') {
  const service = join(cwd, servicePath);
  const successor = prompt.includes('## Handoff from previous attempt');
  let source = readFileSync(service, 'utf8');
  const hadFix = source.includes(FIX_LINE);
  const hadTest = existsSync(join(cwd, regressionPath));
  if (!hadFix) source = source.replace('        return task;', `${FIX_LINE}\n        return task;`);
  if (/Task: Repair the candidate/.test(prompt) && !source.includes(FOLLOW_UP)) source = source.replace(FIX_LINE, `${FOLLOW_UP}\n${FIX_LINE}`);
  if (operatorWantsNullGuard(prompt) && !source.includes(NULL_GUARD)) source = source.replace('    public Task complete(Task task) {\n', `    public Task complete(Task task) {\n${NULL_GUARD}\n`);
  writeFileSync(service, source);
  const repair = /Task: Repair the candidate/.test(prompt);
  if (mode === 'partial') {
    writeChecklist(cwd, { completed: [`TaskService.complete sets RESOLVED (${servicePath})`], pending: [`Add the regression test ${regressionPath}`], notes: 'Only the service change is done; the regression test still has to be added without redoing the service edit.' });
    logAction(provider, issue, 'partial', successor);
  } else {
    const target = join(cwd, regressionPath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(regressionSource, target);
    writeChecklist(cwd, { completed: [hadFix && successor ? 'TaskService change (done by predecessor)' : `TaskService.complete sets RESOLVED`, `Regression test ${regressionPath}`], notes: 'Everything is implemented.' });
    logAction(provider, issue, successor && hadFix && !hadTest ? 'completed_pending' : successor && hadFix && hadTest ? 'noop' : 'full', successor);
  }
  return JSON.stringify({ root_cause: 'TaskService.complete returned the task without persisting RESOLVED.', changes: [`Set RESOLVED in ${servicePath}${repair ? ' and documented the rationale' : ''}.`, `Added ${regressionPath}.`], summary: repair ? 'Repair round applied.' : 'Fix and regression test added.' });
}

function qaWork(cwd, prompt) {
  const digest = /Assess this candidate \(([0-9a-f]{64})\)/.exec(prompt)?.[1];
  if (!digest) throw new Error('candidate digest not found in prompt');
  // The workflow embeds the checks as a single-line JSON object after a "Check results:" heading (older prompts used an inline " Checks: {...}. Return only this JSON shape" form).
  const checks = (() => {
    try {
      const section = /^Check results:\n(\{.*\})$/m.exec(prompt)?.[1] ?? / Checks: (\{.*\})\. Return only this JSON shape/s.exec(prompt)?.[1];
      return JSON.parse(section ?? 'null');
    } catch { return null; }
  })();
  const required = checks?.checks?.filter((check) => check.required) ?? [];
  const checksPass = required.length > 0 && required.every((check) => check.status === 'PASS' && check.exit_code === 0);
  const regressionPresent = existsSync(join(cwd, regressionPath));
  const fixed = readIfPresent(join(cwd, servicePath)).includes(FIX_LINE);
  const operatorRequired = operatorWantsNullGuard(prompt);
  const guarded = readIfPresent(join(cwd, servicePath)).includes(NULL_GUARD);
  const pass = checksPass && regressionPresent && fixed && (!operatorRequired || guarded);
  if (prompt.includes(QA_WRITES)) writeFileSync(join(cwd, servicePath), `${readIfPresent(join(cwd, servicePath))}\n// qa tampering\n`);
  return JSON.stringify({ schema_version: 1, candidate_digest: digest, status: pass ? 'PASS' : 'FAIL', evidence: [
    `Required checks in the prompt: ${checksPass ? 'all PASS with exit code 0' : 'not all passing'}.`,
    `Regression test file present: ${regressionPresent}. TaskService sets RESOLVED: ${fixed}.`,
    ...(operatorRequired ? [`Operator requirement received (null guard on TaskService.complete): ${guarded ? 'satisfied' : 'NOT satisfied'}.`] : []),
  ] });
}

function reviewerWork(cwd, prompt) {
  const digest = /Review this exact candidate \(([0-9a-f]{64})\)/.exec(prompt)?.[1];
  if (!digest) throw new Error('candidate digest not found in prompt');
  const source = readIfPresent(join(cwd, servicePath));
  const lines = source.split('\n');
  const findings = [];
  if (!source.includes(FIX_LINE)) findings.push({ severity: 'BLOCKER', file: servicePath, line: Math.max(1, lines.findIndex((line) => line.includes('return task;')) + 1), issue: 'Completion does not persist RESOLVED.', suggested_fix: `Add ${FIX_LINE.trim()} before returning the task.` });
  if (!existsSync(join(cwd, regressionPath))) findings.push({ severity: 'HIGH', file: servicePath, line: 1, issue: 'No regression test covers the completion status.', suggested_fix: `Add ${regressionPath}.` });
  if (prompt.includes(FAILS_ONCE) && !source.includes(FOLLOW_UP)) findings.push({ severity: 'MEDIUM', file: servicePath, line: Math.max(1, lines.findIndex((line) => line.includes(FIX_LINE)) + 1), issue: 'The status assignment lacks the rationale comment required for this ticket.', suggested_fix: `Add a rationale comment above ${FIX_LINE.trim()}.` });
  if (operatorWantsNullGuard(prompt) && !source.includes(NULL_GUARD)) findings.push({ severity: 'HIGH', file: servicePath, line: 1, issue: 'Operator requirement not met: TaskService.complete lacks the requested null guard.', suggested_fix: `Add ${NULL_GUARD.trim()}.` });
  if (prompt.includes(REVIEWER_WRITES)) writeFileSync(join(cwd, servicePath), `${source}\n// reviewer tampering\n`);
  return JSON.stringify({ schema_version: 1, candidate_digest: digest, status: findings.length ? 'FAIL' : 'PASS', findings });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(provider) {
  // The real adapter delivers the prompt on stdin for claude and codex, and as the last argv element for cursor.
  const prompt = provider === 'cursor' ? (process.argv.at(-1) ?? '') : await readStdin();
  const role = detectRole(prompt);
  const issue = /Issue ([A-Z][A-Z0-9]*-\d+):/.exec(prompt)?.[1] ?? null;
  const cwd = process.cwd();
  // Invocation log written to $HOME (the per-scenario provider home) so tests can count real process spawns.
  if (process.env.HOME && existsSync(process.env.HOME)) {
    appendFileSync(join(process.env.HOME, 'invocations.jsonl'), `${JSON.stringify({ provider, role, issue, cwd, argv: provider === 'cursor' ? process.argv.slice(2, -1) : process.argv.slice(2), repair: /Task: Repair the candidate/.test(prompt), saw_root_rule: prompt.includes('RULE-AUTOS-FIXTURE-7'), saw_nested_rule: prompt.includes('RULE-AUTOS-FIXTURE-NESTED-9'), saw_handoff_section: prompt.includes('## Handoff from previous attempt'), handoff_dir_present: existsSync(join(cwd, '.autos-handoff')) })}\n`);
  }
  // Failure injection comes from a behaviour file in the provider HOME (written by the harness, outside the workspace),
  // never from ticket or prompt text. Shape: { "<provider>": { "<role>": "rate_limit" | "upstream" | "auth" | "malformed" | "edit_then_upstream" } }
  const behaviour = (() => { try { return JSON.parse(readFileSync(join(process.env.HOME ?? '', 'fake-provider-behavior.json'), 'utf8'))?.[provider]?.[role]; } catch { return undefined; } })();
  if (behaviour === 'malformed') { process.stdout.write('this is not a valid provider envelope\n'); return; }
  if (['rate_limit', 'upstream', 'auth', 'edit_then_upstream', 'edit_then_auth', 'partial_then_rate_limit'].includes(behaviour)) {
    if (behaviour === 'partial_then_rate_limit' && role === 'swe') sweWork(cwd, prompt, provider, issue, 'partial');
    if ((behaviour === 'edit_then_upstream' || behaviour === 'edit_then_auth') && role === 'swe') sweWork(cwd, prompt, provider, issue, 'partial');
    const message = { rate_limit: 'rate limit exceeded: too many requests (HTTP 429)', upstream: 'overloaded_error: service unavailable (HTTP 503)', auth: 'authentication failed: please run /login', edit_then_upstream: 'overloaded_error: service unavailable (HTTP 503)', edit_then_auth: 'authentication failed: please run /login', partial_then_rate_limit: 'rate limit exceeded: too many requests (HTTP 429)' }[behaviour];
    if (provider === 'codex') {
      process.stdout.write(`${JSON.stringify({ type: 'error', message })}\n${JSON.stringify({ type: 'turn.failed', error: { message } })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: message })}\n`);
    }
    process.exit(1);
  }
  if (behaviour === 'edit_agents_md' && role === 'swe') appendFileSync(join(cwd, 'AGENTS.md'), '\nRULE-TAMPERED: SWE edited the instruction file.\n');
  let text;
  if (role === 'swe') text = sweWork(cwd, prompt, provider, issue);
  else if (role === 'qa') text = qaWork(cwd, prompt);
  else if (role === 'reviewer') text = reviewerWork(cwd, prompt);
  else { process.stderr.write('fake provider: unrecognized prompt\n'); process.exit(2); }
  if (provider === 'codex') {
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
  } else {
    // Realistic stream-json shape: init, assistant tool_use, user tool_result, then the terminal result line.
    const lines = [
      { type: 'system', subtype: 'init', session_id: 'fake-session', cwd, model: 'fake-model', tools: ['Read', 'Edit'] },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Inspecting the workspace.' }, { type: 'tool_use', id: 'toolu_fake1', name: 'Read', input: { file_path: 'README.md' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake1', content: 'fake file contents' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 2, session_id: 'fake-session' },
    ];
    for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}
