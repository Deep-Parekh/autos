/**
 * HTTP endpoint for the Teams bot. Accepts only POST /api/messages (Bot Framework activities) and GET /healthz.
 * Order of checks for every activity: body size and JSON → activity shape → Bot Framework JWT → Teams channel and
 * tenant → sender allowlist → command parsing → controller call. The HTTP answer (200) is sent before the command
 * runs; replies go out through the Bot Connector API. Duplicate deliveries (same activity id) are dropped.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { AutosError } from '@autos/contracts';
import { actorLabel, runCommand, type ControllerClient } from './actions.js';
import type { BotAuthenticator } from './auth.js';
import { helpCard, messageCard } from './cards.js';
import { parseCardSubmit, parseCommandText } from './commands.js';
import { activitySchema, type Activity, type OutgoingMessage, type ParseContext } from './types.js';

export const MAX_BODY_BYTES = 256 * 1024;
const DEDUPE_SIZE = 500;

export interface BotServerOptions {
  tenantId: string;
  allowedUsers: readonly string[];
  parse: ParseContext;
  auth: BotAuthenticator;
  connector: { reply(activity: Activity, message: OutgoingMessage): Promise<{ ok: boolean; status: number | null }> };
  controller: ControllerClient;
  log: (record: Record<string, unknown>) => void;
}

const membersAddedSchema = z.object({ membersAdded: z.array(z.object({ id: z.string().max(512) })).max(100).optional() });

export function createBotHandler(options: BotServerOptions): { handle(request: IncomingMessage, response: ServerResponse): void; idle(): Promise<void> } {
  const allowed = new Set(options.allowedUsers.map((id) => id.toLowerCase()));
  const seen: string[] = []; const seenSet = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const remember = (id: string): boolean => {
    if (seenSet.has(id)) return false;
    seenSet.add(id); seen.push(id);
    if (seen.length > DEDUPE_SIZE) seenSet.delete(seen.shift()!);
    return true;
  };
  const send = async (activity: Activity, message: OutgoingMessage, kind: string) => {
    const result = await options.connector.reply(activity, message);
    options.log(result.ok ? { event: 'teams_bot_replied', activity_id: activity.id ?? null, kind } : { event: 'teams_bot_reply_failed', activity_id: activity.id ?? null, kind, status: result.status });
  };

  async function process(activity: Activity, raw: unknown): Promise<void> {
    const tenant = activity.conversation.tenantId ?? activity.channelData?.tenant?.id;
    if (activity.channelId !== 'msteams' || tenant?.toLowerCase() !== options.tenantId.toLowerCase()) { options.log({ event: 'teams_bot_ignored', reason: 'channel or tenant', activity_id: activity.id ?? null }); return; }
    if (activity.type === 'conversationUpdate') {
      const added = membersAddedSchema.safeParse(raw);
      if (added.success && activity.recipient && added.data.membersAdded?.some((member) => member.id === activity.recipient!.id)) await send(activity, { card: helpCard() }, 'welcome');
      return;
    }
    if (activity.type !== 'message') return;
    const user = activity.from.aadObjectId?.toLowerCase();
    if (!user || !allowed.has(user)) {
      options.log({ event: 'teams_bot_refused', activity_id: activity.id ?? null, user: user ?? null });
      await send(activity, { text: 'Sorry, you are not allowed to use Autos. Ask the Autos operator to add your Entra object ID to teams_bot.allowed_users.' }, 'refused');
      return;
    }
    const parsed = activity.value !== undefined && activity.value !== null ? parseCardSubmit(activity.value, options.parse) : parseCommandText(activity.text ?? '', options.parse);
    if (!parsed.ok) { await send(activity, { card: messageCard('I did not understand that', [parsed.message, 'Type help for the commands.'], 'warning') }, 'unparsed'); return; }
    const command = parsed.command;
    options.log({ event: 'teams_bot_command', activity_id: activity.id ?? null, kind: command.kind, issue_key: 'issueKey' in command ? command.issueKey ?? null : null, user });
    let reply: OutgoingMessage;
    try { reply = await runCommand(command, { controller: options.controller, actor: actorLabel(user), jiraSiteUrl: options.parse.jiraSiteUrl }); }
    catch (error) {
      const code = error instanceof AutosError ? error.code : 'INTERNAL';
      options.log({ event: 'teams_bot_command_failed', activity_id: activity.id ?? null, kind: command.kind, code });
      reply = { card: messageCard('Autos could not do that', [code === 'UPSTREAM' ? 'The Autos controller is not reachable. Is it running?' : `Error: ${code}`], 'attention') };
    }
    await send(activity, reply, command.kind);
  }

  function handle(request: IncomingMessage, response: ServerResponse): void {
    const finish = (status: number, body = '') => { if (!response.headersSent) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(body); } };
    const path = (request.url ?? '').split('?')[0];
    if (request.method === 'GET' && path === '/healthz') { finish(200, '{"ok":true}'); return; }
    if (request.method !== 'POST' || path !== '/api/messages') { finish(404, '{"error":"not found"}'); return; }
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { finish(415, '{"error":"json required"}'); request.resume(); return; }
    const chunks: Buffer[] = []; let size = 0; let aborted = false;
    request.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { aborted = true; finish(413, '{"error":"too large"}'); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('error', () => { aborted = true; });
    request.on('end', () => {
      if (aborted) return;
      void (async () => {
        let raw: unknown;
        try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { finish(400, '{"error":"bad json"}'); return; }
        const parsed = activitySchema.safeParse(raw);
        if (!parsed.success) { finish(400, '{"error":"bad activity"}'); return; }
        const authorization = Array.isArray(request.headers.authorization) ? undefined : request.headers.authorization;
        let verdict: Awaited<ReturnType<BotAuthenticator['verify']>>;
        try { verdict = await options.auth.verify(authorization, parsed.data); } catch { verdict = { ok: false, reason: 'metadata unavailable' }; }
        if (!verdict.ok) { options.log({ event: 'teams_bot_auth_rejected', reason: verdict.reason }); finish(401, '{"error":"unauthorized"}'); return; }
        finish(200, '{}');
        if (parsed.data.id && !remember(`${parsed.data.conversation.id}|${parsed.data.id}`)) { options.log({ event: 'teams_bot_duplicate', activity_id: parsed.data.id }); return; }
        const work = process(parsed.data, raw).catch((error: unknown) => { options.log({ event: 'teams_bot_failed', code: error instanceof AutosError ? error.code : 'INTERNAL' }); });
        inFlight.add(work); void work.finally(() => inFlight.delete(work));
      })();
    });
  }

  return { handle, idle: async () => { while (inFlight.size) await Promise.all([...inFlight]); } };
}

export function createBotServer(options: BotServerOptions): { server: Server; idle(): Promise<void> } {
  const handler = createBotHandler(options);
  const server = createServer((request, response) => handler.handle(request, response));
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return { server, idle: handler.idle };
}
