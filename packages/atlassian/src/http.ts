import { AutosError } from '@autos/contracts';

/** Shared HTTP helpers for the Atlassian read client and the Confluence draft writer. */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type HttpMethod = 'GET' | 'POST' | 'PUT';

export function safeError(code: ConstructorParameters<typeof AutosError>[0], message: string, retryable = false): AutosError {
  return new AutosError(code, message, { retryable });
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(safeError('CANCELLED', 'Atlassian request cancelled'));
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', cancel); resolve(); }
    function cancel() { clearTimeout(timer); reject(safeError('CANCELLED', 'Atlassian request cancelled')); }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Builds a URL on `site` and refuses any path that would leave the site's origin. */
export function siteUrl(site: string, path: string, query?: Record<string, string>): URL {
  const url = new URL(path, site);
  if (url.origin !== new URL(site).origin) throw safeError('INTERNAL', 'Refused an unsafe Atlassian URL');
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

export interface JsonRequest {
  fetcher: FetchLike;
  sleep: Sleep;
  timeoutMs: number;
  retries: number;
  url: URL;
  auth: string;
  method?: HttpMethod | undefined;
  /** JSON request body (writes only). Never echoed into errors. */
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Status codes returned to the caller as `{ status }` instead of thrown (e.g. 404/409 for draft supersession). */
  passStatuses?: readonly number[] | undefined;
}

export type JsonResult = { status: number; json: unknown };

/**
 * One JSON request with origin pinning (by construction of `url`), manual redirects refused, timeout, cancellation,
 * and 429/5xx retry honoring Retry-After. Writes (POST/PUT) retry only on 429, because a 5xx may have been applied.
 * Errors never include URLs, bodies or credentials.
 */
export async function requestJson(request: JsonRequest): Promise<JsonResult> {
  const { fetcher, sleep, timeoutMs, retries, url, auth, signal } = request;
  const method = request.method ?? 'GET';
  const isRead = method === 'GET';
  const noun = isRead ? 'read request' : 'write request';
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw safeError('CANCELLED', 'Atlassian request cancelled');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortParent = () => controller.abort();
    signal?.addEventListener('abort', abortParent, { once: true });
    try {
      const headers: Record<string, string> = { Accept: 'application/json', Authorization: auth };
      const init: RequestInit = { method, headers, redirect: 'manual', signal: controller.signal };
      if (request.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(request.body); }
      const response = await fetcher(url, init);
      if (controller.signal.aborted) throw safeError('TIMEOUT', 'Atlassian request timed out', true);
      if (response.status >= 300 && response.status < 400) throw safeError('FORBIDDEN', `Atlassian redirected a ${noun}; redirect refused`);
      if ((response.status === 429 || (isRead && response.status >= 500)) && attempt < retries) {
        const retryAfter = response.headers.get('retry-after');
        const parsedSeconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
        const delay = Number.isFinite(parsedSeconds) ? Math.min(30_000, Math.max(0, parsedSeconds * 1000)) : Math.min(5_000, 200 * 2 ** attempt);
        await response.body?.cancel().catch(() => undefined);
        await sleep(delay, signal);
        continue;
      }
      if (request.passStatuses?.includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, json: undefined };
      }
      // Atlassian "scoped" API tokens only work through the api.atlassian.com gateway, which this
      // client does not support (it calls the site URL directly), so they surface here as 401.
      if (response.status === 401) throw safeError('AUTH', 'Atlassian authentication failed; use a classic (unscoped) API token for this site');
      if (response.status === 403) throw safeError('FORBIDDEN', 'Atlassian denied access to the requested resource');
      if (response.status === 404) throw safeError('NOT_FOUND', 'Atlassian resource was not found');
      if (response.status === 409 && !isRead) throw safeError('CONFLICT', 'Atlassian reported a conflicting change');
      if (response.status === 429) throw safeError('RATE_LIMIT', 'Atlassian rate limit persisted after retries', true);
      if (!response.ok) throw safeError('UPSTREAM', `Atlassian ${noun} failed`, response.status >= 500);
      let json: unknown;
      try { json = await response.json(); } catch {
        if (signal?.aborted) throw safeError('CANCELLED', 'Atlassian request cancelled');
        if (controller.signal.aborted) throw safeError('TIMEOUT', 'Atlassian request timed out', true);
        throw safeError('UPSTREAM', 'Atlassian returned invalid JSON');
      }
      if (signal?.aborted) throw safeError('CANCELLED', 'Atlassian request cancelled');
      if (controller.signal.aborted) throw safeError('TIMEOUT', 'Atlassian request timed out', true);
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof AutosError) throw error;
      if (signal?.aborted) throw safeError('CANCELLED', 'Atlassian request cancelled');
      if (controller.signal.aborted) throw safeError('TIMEOUT', 'Atlassian request timed out', true);
      throw safeError('UPSTREAM', 'Atlassian could not be reached', true);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortParent);
    }
  }
}
