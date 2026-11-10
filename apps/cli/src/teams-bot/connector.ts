import { z } from 'zod';
import { AutosError } from '@autos/contracts';
import type { FetchLike } from '../teams.js';
import type { Activity, AdaptiveCard, ConversationRef, OutgoingMessage } from './types.js';

const connectorIdSchema = z.string().min(1).max(2048);
const sendResponseSchema = z.object({ id: z.string().min(1).max(2048) });
const ALLOWED_SUFFIXES = ['.botframework.com', '.teams.microsoft.com', '.teams.microsoft.us'] as const;

/** Validates an Activity service URL before it is used as a request destination. */
export function parseServiceUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AutosError('POLICY', 'Teams service URL is invalid'); }
  const host = url.hostname.toLowerCase();
  const allowedHost = host === 'smba.trafficmanager.net' || ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !allowedHost) {
    throw new AutosError('POLICY', 'Teams service URL is not allowed');
  }
  return url;
}

/** Builds a connector reference from a validated inbound activity. */
export function conversationRef(activity: Activity): ConversationRef {
  const tenantId = activity.conversation.tenantId ?? activity.channelData?.tenant?.id;
  return {
    serviceUrl: parseServiceUrl(activity.serviceUrl).toString(),
    conversationId: activity.conversation.id,
    ...(tenantId === undefined ? {} : { tenantId }),
  };
}

export interface ConnectorOptions {
  tokens: { token(signal?: AbortSignal): Promise<string>; invalidate(): void };
  fetch?: FetchLike;
  retryDelayMs?: number;
}

type Operation = 'POST' | 'PUT';
interface DeliveryRequest { method: Operation; url: URL; message: OutgoingMessage; readActivityId: boolean }

/** A small Bot Connector API client. It never returns upstream bodies or includes credentials in errors. */
export class ConnectorClient {
  private readonly doFetch: FetchLike;

  constructor(private readonly options: ConnectorOptions) {
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  reply(activity: Activity, message: OutgoingMessage): Promise<{ ok: boolean; status: number | null }> {
    if (!activity.id) return Promise.resolve({ ok: false, status: null });
    const url = this.endpoint({ serviceUrl: activity.serviceUrl, conversationId: activity.conversation.id }, [activity.id]);
    return this.deliver({ method: 'POST', url, message, readActivityId: false });
  }

  send(ref: ConversationRef, message: OutgoingMessage): Promise<{ ok: boolean; status: number | null; activityId?: string }> {
    const url = this.endpoint(ref, []);
    return this.deliver({ method: 'POST', url, message, readActivityId: true });
  }

  update(ref: ConversationRef, activityId: string, message: OutgoingMessage): Promise<{ ok: boolean; status: number | null }> {
    const url = this.endpoint(ref, [activityId]);
    return this.deliver({ method: 'PUT', url, message, readActivityId: false });
  }

  private endpoint(ref: ConversationRef, tail: string[]): URL {
    const service = parseServiceUrl(ref.serviceUrl);
    const conversationId = safeId(ref.conversationId);
    const segments = ['v3', 'conversations', conversationId, 'activities', ...tail.map(safeId)];
    const url = new URL(service);
    url.pathname = `${service.pathname.replace(/\/+$/, '')}/${segments.map(encodeURIComponent).join('/')}`;
    return url;
  }

  private async deliver(request: DeliveryRequest): Promise<{ ok: boolean; status: number | null; activityId?: string }> {
    let status: number | null = null;
    let attempts = 0;
    let refreshed = false;
    while (attempts < 3) {
      attempts++;
      const timeout = AbortSignal.timeout(15_000);
      let retryAfter: number | undefined;
      try {
        const token = await this.options.tokens.token(timeout);
        const response = await this.doFetch(request.url, {
          method: request.method,
          redirect: 'error',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(messageBody(request.message)),
          signal: timeout,
        });
        status = response.status;

        if (status === 401 && !refreshed) {
          refreshed = true;
          attempts--;
          this.options.tokens.invalidate();
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        if (response.ok) {
          let activityId: string | undefined;
          if (request.readActivityId) {
            try {
              const parsed = sendResponseSchema.safeParse(await response.json());
              if (parsed.success) activityId = parsed.data.id;
            } catch { /* A successful send remains successful if the optional response id is absent or malformed. */ }
          } else {
            await response.body?.cancel().catch(() => undefined);
          }
          return { ok: true, status, ...(activityId === undefined ? {} : { activityId }) };
        }

        retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        await response.body?.cancel().catch(() => undefined);
        if (!(status === 429 || status >= 500)) return { ok: false, status };
      } catch {
        // Network, timeout, and token-source errors are reported only as a null status.
        status = null;
      }

      if (attempts < 3) await delay(retryAfter ?? (this.options.retryDelayMs ?? 1000) * 2 ** (attempts - 1));
    }
    return { ok: false, status };
  }
}

function safeId(value: string): string {
  const parsed = connectorIdSchema.safeParse(value);
  if (!parsed.success) throw new AutosError('POLICY', 'Teams activity identifier is invalid');
  return parsed.data;
}

function messageBody(message: OutgoingMessage): { type: 'message'; text?: string; attachments?: Array<{ contentType: string; content: AdaptiveCard }> } {
  return {
    type: 'message',
    ...(message.text === undefined ? {} : { text: message.text }),
    ...(message.card === undefined ? {} : { attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: message.card }] }),
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  const delayMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delayMs) && delayMs >= 0 ? Math.min(delayMs, 30_000) : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
