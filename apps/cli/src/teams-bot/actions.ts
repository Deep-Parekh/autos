/**
 * Turns a parsed `BotCommand` from an allowed Teams user into controller API calls and the reply message. The bot
 * only calls the same authenticated controller routes the CLI uses; it never talks to Jira, Git or agents itself.
 * Controller error replies are reduced to their Autos-authored `code` and `message`.
 */
import { AutosError, jobRecordSchema, type AgentRole, type JobRecord } from '@autos/contracts';
import { z } from 'zod';
import type { FetchLike } from '../teams.js';
import { confirmCard, helpCard, jobCard, messageCard, runFormCard, statusCard } from './cards.js';
import type { BotCommand, OutgoingMessage, RoleNotes } from './types.js';

export interface ControllerResponse { status: number; body: unknown }
export interface ControllerClient { request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options?: { body?: unknown; actor?: string }): Promise<ControllerResponse> }

/** Authenticated JSON client for the loopback controller. Network failures become UPSTREAM errors without details. */
export function createControllerClient(base: URL, token: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): ControllerClient {
  const root = base.href.endsWith('/') ? base : new URL(`${base.href}/`);
  return {
    async request(method, path, options = {}) {
      const url = new URL(path.replace(/^\//, ''), root);
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (options.actor) headers['x-autos-operator'] = options.actor;
      let response: Response;
      try {
        response = await fetchImpl(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000), ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
      } catch { throw new AutosError('UPSTREAM', 'Autos controller is not reachable', { retryable: true }); }
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status, body };
    },
  };
}

/** Audit label for controller calls: matches the controller's X-Autos-Operator pattern. */
export function actorLabel(aadObjectId: string): string { return `teams-${aadObjectId.toLowerCase().replace(/[^0-9a-f-]/g, '')}`.slice(0, 64); }

const errorBodySchema = z.object({ code: z.string().max(64), message: z.string().max(500) });
function failure(what: string, response: ControllerResponse): OutgoingMessage {
  const parsed = errorBodySchema.safeParse(response.body);
  const detail = parsed.success ? `${parsed.data.message} (${parsed.data.code})` : `HTTP ${response.status}`;
  return { card: messageCard(`Could not ${what}`, [detail], 'attention') };
}
const ok = (response: ControllerResponse) => response.status >= 200 && response.status < 300;
function job(response: ControllerResponse): JobRecord | null { const parsed = jobRecordSchema.safeParse(response.body); return parsed.success ? parsed.data as JobRecord : null; }

/** Role notes → controller note requests: identical text for several roles becomes one note. */
export function noteRequests(notes: RoleNotes): Array<{ instructions: string; roles: AgentRole[] }> {
  const byText = new Map<string, AgentRole[]>();
  for (const role of ['swe', 'qa', 'reviewer'] as const) {
    const textValue = notes[role]?.trim(); if (!textValue) continue;
    byText.set(textValue, [...(byText.get(textValue) ?? []), role]);
  }
  return [...byText].map(([instructions, roles]) => ({ instructions, roles }));
}

export interface ActionContext { controller: ControllerClient; actor: string; jiraSiteUrl: string }

export async function runCommand(command: BotCommand, ctx: ActionContext): Promise<OutgoingMessage> {
  const { controller, actor } = ctx; const key = (issueKey: string) => encodeURIComponent(issueKey);
  switch (command.kind) {
    case 'help': return { card: helpCard() };
    case 'run_form': return { card: runFormCard(command.issueKey ? { issueKey: command.issueKey } : {}) };
    case 'status': {
      const response = await controller.request('GET', '/v1/status');
      return ok(response) ? { card: statusCard(response.body) } : failure('read the status', response);
    }
    case 'show': {
      const response = await controller.request('GET', `/v1/issues/${key(command.issueKey)}`);
      if (response.status === 404) return { card: messageCard(`Autos has no record of ${command.issueKey}`, ['Start it with: run ' + command.issueKey], 'default') };
      if (!ok(response)) return failure(`show ${command.issueKey}`, response);
      const attempts = z.object({ attempts: z.array(z.unknown()) }).safeParse(response.body);
      const latest = attempts.success && attempts.data.attempts.length ? jobRecordSchema.safeParse(attempts.data.attempts[0]) : null;
      return latest?.success ? { card: jobCard(latest.data as JobRecord, { jiraSiteUrl: ctx.jiraSiteUrl }) } : { card: messageCard(`${command.issueKey} has no attempts yet`, ['It has ticket notes or a hold only.'], 'default') };
    }
    case 'run': {
      const notes = noteRequests(command.notes);
      if (notes.length > 5) return { card: messageCard('Too many notes', ['At most 5 different notes per run.'], 'warning') };
      const response = await controller.request('POST', '/v1/jobs', { actor, body: { issue_key: command.issueKey, dry_run: command.dryRun, ...(notes.length ? { notes } : {}) } });
      const queued = job(response);
      if (!ok(response) || !queued) return failure(`start ${command.issueKey}`, response);
      return { card: jobCard(queued, { jiraSiteUrl: ctx.jiraSiteUrl, heading: command.dryRun ? `Dry run queued for ${command.issueKey}` : `Queued ${command.issueKey}` }) };
    }
    case 'note': {
      const notes = noteRequests(command.notes);
      for (const note of notes) {
        const response = await controller.request('POST', `/v1/issues/${key(command.issueKey)}/notes`, { actor, body: note });
        if (!ok(response)) return failure(`add the note to ${command.issueKey}`, response);
      }
      if (command.hold) {
        const response = await controller.request('PUT', `/v1/issues/${key(command.issueKey)}/hold`, { actor });
        if (!ok(response)) return failure(`hold ${command.issueKey}`, response);
      }
      const lines = notes.map((note) => `Note for ${note.roles.join(', ')} saved.`);
      if (command.hold) lines.push('Held: Autos will not pick it up automatically until you release it.');
      return { card: messageCard(`Updated ${command.issueKey}`, lines.length ? lines : ['Nothing to save.'], 'good') };
    }
    case 'release': {
      const response = await controller.request('DELETE', `/v1/issues/${key(command.issueKey)}/hold`, { actor });
      return ok(response) ? { card: messageCard(`Released ${command.issueKey}`, ['Autos may pick it up again.'], 'good') } : failure(`release ${command.issueKey}`, response);
    }
    case 'revise': {
      const response = await controller.request('POST', `/v1/issues/${key(command.issueKey)}/revisions`, { actor, body: { instructions: command.note, roles: command.roles } });
      const queued = job(response);
      if (!ok(response) || !queued) return failure(`revise ${command.issueKey}`, response);
      return { card: jobCard(queued, { jiraSiteUrl: ctx.jiraSiteUrl, heading: `Revision queued for ${command.issueKey}` }) };
    }
    case 'retry': {
      const response = await controller.request('POST', `/v1/jobs/${key(command.jobId)}/retry`, { actor });
      const queued = job(response);
      if (!ok(response) || !queued) return failure('retry the job', response);
      return { card: jobCard(queued, { jiraSiteUrl: ctx.jiraSiteUrl, heading: `Retry queued for ${queued.issue_key}` }) };
    }
    case 'cancel': {
      if (!command.confirmed) return { card: confirmCard(command) };
      const response = await controller.request('POST', `/v1/jobs/${key(command.jobId)}/cancel`, { actor });
      const cancelled = job(response);
      if (!ok(response) || !cancelled) return failure('cancel the job', response);
      return { card: jobCard(cancelled, { jiraSiteUrl: ctx.jiraSiteUrl, heading: `Cancelling ${cancelled.issue_key}` }) };
    }
    case 'close': {
      if (!command.confirmed) return { card: confirmCard(command) };
      const response = await controller.request('POST', `/v1/issues/${key(command.issueKey)}/close`, { actor, body: { resolution: command.resolution } });
      return ok(response) ? { card: messageCard(`Closed ${command.issueKey} as ${command.resolution}`, ['Its workspace will be cleaned up; new attempts are refused.'], 'good') } : failure(`close ${command.issueKey}`, response);
    }
  }
}
