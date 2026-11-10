import { z } from 'zod';
import type { JobRecord } from '@autos/contracts';
import type { AdaptiveCard, BotCommand } from './types.js';

const base = (body: unknown[], actions: unknown[] = []): AdaptiveCard => ({
  $schema: 'https://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
  msteams: { width: 'Full' }, body, ...(actions.length ? { actions } : {}),
});
const text = (value: string, size: 'default' | 'large' = 'default', weight: 'default' | 'bolder' = 'default') => ({ type: 'TextBlock', text: sanitize(value), wrap: true, size, weight });
function sanitize(value: unknown, max = 500): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/[\[\]*`<>]/g, '').slice(0, max);
}
const submit = (data: Record<string, unknown>) => ({ type: 'Action.Submit', title: '', data });
const fact = (title: string, value: unknown) => ({ title, value: sanitize(value, 300) || '—' });

export function helpCard(): AdaptiveCard {
  return base([text('Autos Teams bot', 'large', 'bolder'), text('Mention Autos with a Jira key and instructions, or use a command.'),
    text('Commands: help · run · status · show KEY · note KEY text · release KEY · revise KEY text · retry JOB_ID · cancel JOB_ID · close KEY merged|abandoned'),
    text('Use Run to open the request form. Close and cancel require confirmation.')], [submit({ autos: 'v1', action: 'run_form' }), submit({ autos: 'v1', action: 'status' })]);
}

export function runFormCard(options: { issueKey?: string } = {}): AdaptiveCard {
  const body: unknown[] = [text('Run Autos', 'large', 'bolder'),
    { type: 'Input.Text', id: 'issue', label: 'Jira link or key', isRequired: true, errorMessage: 'Enter a Jira issue key or link.', ...(options.issueKey ? { value: sanitize(options.issueKey, 100) } : {}) },
    ...(['swe', 'qa', 'reviewer'] as const).map((role) => ({ type: 'Input.Text', id: role, label: `${role.toUpperCase()} instructions`, isMultiline: true })),
    { type: 'Input.Toggle', id: 'dry_run', title: 'Dry run', valueOn: 'true', valueOff: 'false', value: 'false' }];
  return base(body, [{ ...submit({ autos: 'v1', action: 'run' }), title: 'Start run' }]);
}

export function jobCard(job: JobRecord, options: { jiraSiteUrl: string; heading?: string }): AdaptiveCard {
  const stateTitle: Record<string, string> = { READY_FOR_HUMAN: 'Ready for human review', BLOCKED: 'Job blocked', CANCELLED: 'Job cancelled', PAUSED: 'Job paused' };
  const body: unknown[] = [text(options.heading ?? stateTitle[job.state] ?? `Autos job ${job.state.toLowerCase()}`, 'large', 'bolder'),
    { type: 'FactSet', facts: [fact('Job', job.job_id), fact('Issue', job.issue_key), fact('State', job.state), fact('Branch', job.feature_branch), fact('Commit', job.commit_sha?.slice(0, 12)), fact('Repair rounds', job.repair_round), ...(job.blocked_code ? [fact('Blocked code', job.blocked_code)] : []), ...(job.blocked_reason ? [fact('Reason', job.blocked_reason)] : [])] }];
  const actions: unknown[] = [];
  const issue = sanitize(job.issue_key, 100);
  if (/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(issue)) {
    let url: URL | undefined;
    try { const origin = new URL(options.jiraSiteUrl); if (origin.protocol === 'https:' && !origin.username && !origin.password) { origin.pathname = `${origin.pathname.replace(/\/$/, '')}/browse/${encodeURIComponent(issue)}`; origin.search = ''; origin.hash = ''; url = origin; } } catch { /* omit unusable link */ }
    if (url) actions.push({ type: 'Action.OpenUrl', title: 'Open in Jira', url: url.toString() });
  }
  if (job.state === 'READY_FOR_HUMAN') {
    actions.push({ type: 'Action.ShowCard', title: 'Revise', card: base([{ type: 'Input.Text', id: 'note', label: 'What should change?', isMultiline: true }], [{ ...submit({ autos: 'v1', action: 'revise', issue }), title: 'Request revision' }]) });
    actions.push({ ...submit({ autos: 'v1', action: 'close', issue, resolution: 'merged' }), title: 'Close as merged' }, { ...submit({ autos: 'v1', action: 'close', issue, resolution: 'abandoned' }), title: 'Close as abandoned' });
  } else if (job.state === 'BLOCKED' || job.state === 'CANCELLED') {
    actions.push({ ...submit({ autos: 'v1', action: 'retry', job_id: job.job_id }), title: 'Retry' });
    actions.push({ type: 'Action.ShowCard', title: 'Revise', card: base([{ type: 'Input.Text', id: 'note', label: 'What should change?', isMultiline: true }], [{ ...submit({ autos: 'v1', action: 'revise', issue }), title: 'Request revision' }]) });
  } else if (['QUEUED', 'INVESTIGATING', 'PLANNED', 'IMPLEMENTING', 'QA', 'REVIEW', 'REVISING', 'PAUSED', 'CANCELLING'].includes(job.state)) {
    actions.push({ ...submit({ autos: 'v1', action: 'cancel', job_id: job.job_id }), title: 'Cancel' });
  }
  return base(body, actions);
}

const statusSchema = z.object({ controller: z.object({ poll_loop: z.object({ auto_poll: z.boolean() }).partial() }).partial().optional(), activity: z.object({ counts: z.record(z.string(), z.number().int().nonnegative()).optional(), provider_limits: z.object({ gate_active: z.boolean() }).partial().optional() }).partial().optional(), active_jobs: z.array(z.object({ issue_key: z.string().max(100), state: z.string().max(64) })).max(1000).optional() }).passthrough();
export function statusCard(status: unknown): AdaptiveCard {
  const parsed = statusSchema.safeParse(status);
  if (!parsed.success) return messageCard('Autos status unavailable', ['The controller returned an unreadable status response.'], 'warning');
  const data = parsed.data; const counts = data.activity?.counts ?? {};
  const runningStates = new Set(['INVESTIGATING', 'PLANNED', 'IMPLEMENTING', 'QA', 'REVIEW', 'REVISING', 'CANCELLING']);
  const running = Object.entries(counts).filter(([state]) => runningStates.has(state)).reduce((n, [, count]) => n + count, 0);
  const active = (data.active_jobs ?? []).slice(0, 10);
  return base([text('Autos status', 'large', 'bolder'), { type: 'FactSet', facts: [fact('Running', running), fact('Paused', counts.PAUSED ?? 0), fact('Queued', counts.QUEUED ?? 0), fact('Auto poll', data.controller?.poll_loop?.auto_poll === true ? 'On' : 'Off'), fact('Provider limit gate', data.activity?.provider_limits?.gate_active === true ? 'Active' : 'Inactive')] }, text('Active jobs', 'default', 'bolder'), ...(active.length ? active.map((job) => text(`${sanitize(job.issue_key, 100)} · ${sanitize(job.state, 64)}`)) : [text('None')])]);
}

export function confirmCard(command: Extract<BotCommand, { kind: 'close' | 'cancel' }>): AdaptiveCard {
  const close = command.kind === 'close'; const title = close ? `Yes, close ${sanitize(command.issueKey, 100)} as ${command.resolution}` : 'Yes, cancel';
  const data = close ? { autos: 'v1', action: 'close', issue: command.issueKey, resolution: command.resolution, confirmed: true } : { autos: 'v1', action: 'cancel', job_id: command.jobId, confirmed: true };
  return base([text(close ? `Confirm closing ${command.issueKey} as ${command.resolution}` : 'Confirm cancelling this job', 'large', 'bolder')], [{ ...submit(data), title }, { ...submit({ autos: 'v1', action: 'status' }), title: 'No, nothing changed' }]);
}

export function messageCard(title: string, lines: string[] = [], tone: 'good' | 'warning' | 'attention' | 'default' = 'default'): AdaptiveCard {
  const color = tone === 'good' ? 'good' : tone === 'warning' ? 'warning' : tone === 'attention' ? 'attention' : 'default';
  return base([text(title, 'large', 'bolder'), ...lines.map((line) => ({ ...text(line), color }))]);
}
