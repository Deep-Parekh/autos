import { AutosError } from '@autos/contracts';
import { createLocalJWKSet, decodeJwt, errors, jwtVerify, type JWTPayload, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import type { Activity } from './types.js';
import type { FetchLike } from '../teams.js';

export interface BotAuthOptions { appId: string; tenantId: string; fetch?: FetchLike; now?: () => number }
export interface BotAuthenticator { verify(authorization: string | undefined, activity: Activity): Promise<{ ok: true } | { ok: false; reason: string }> }

const metadataSchema = z.object({ issuer: z.string().min(1).max(2048), jwks_uri: z.string().url().max(2048) });
const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(128) });
const CACHE_MS = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;

interface IssuerSpec { issuer: string; metadataUrl: URL; jwksHost: string }
interface CachedIssuer { expiresAt: number; keys: ReturnType<typeof createLocalJWKSet>; lastUnknownKidRefresh: number }

function issuerSpec(issuer: string, tenantId: string): IssuerSpec | undefined {
  if (issuer === 'https://api.botframework.com') return {
    issuer,
    metadataUrl: new URL('https://login.botframework.com/v1/.well-known/openidconfiguration'),
    jwksHost: 'login.botframework.com',
  };
  const v1 = `https://sts.windows.net/${tenantId}/`;
  if (issuer === v1) return {
    issuer,
    metadataUrl: new URL(`https://login.microsoftonline.com/${tenantId}/.well-known/openid-configuration`),
    jwksHost: 'login.microsoftonline.com',
  };
  const v2 = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  if (issuer === v2) return {
    issuer,
    metadataUrl: new URL(`https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`),
    jwksHost: 'login.microsoftonline.com',
  };
  return undefined;
}

function safeFetch(fetcher: FetchLike, url: URL): Promise<Response> {
  return fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
}

export function createBotAuthenticator(options: BotAuthOptions): BotAuthenticator {
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedIssuer>();
  const refreshTimes = new Map<string, number>();

  async function load(spec: IssuerSpec): Promise<CachedIssuer> {
    const current = now();
    const cached = cache.get(spec.issuer);
    if (cached && cached.expiresAt > current) return cached;
    try {
      const metadataResponse = await safeFetch(fetcher, spec.metadataUrl);
      if (!metadataResponse.ok) throw new Error('metadata response');
      const metadataParsed = metadataSchema.safeParse(await metadataResponse.json());
      if (!metadataParsed.success || metadataParsed.data.issuer !== spec.issuer) throw new Error('metadata shape');
      const jwksUrl = new URL(metadataParsed.data.jwks_uri);
      if (jwksUrl.protocol !== 'https:' || jwksUrl.username || jwksUrl.password || jwksUrl.hostname.toLowerCase() !== spec.jwksHost) throw new Error('key URL');
      const keysResponse = await safeFetch(fetcher, jwksUrl);
      if (!keysResponse.ok) throw new Error('keys response');
      const parsedKeys = jwksSchema.safeParse(await keysResponse.json());
      if (!parsedKeys.success) throw new Error('keys shape');
      const keySet = { keys: parsedKeys.data.keys } as JSONWebKeySet;
      const loaded: CachedIssuer = { expiresAt: current + CACHE_MS, keys: createLocalJWKSet(keySet), lastUnknownKidRefresh: refreshTimes.get(spec.issuer) ?? Number.NEGATIVE_INFINITY };
      cache.set(spec.issuer, loaded);
      return loaded;
    } catch {
      throw new AutosError('UPSTREAM', 'Bot authentication metadata unavailable');
    }
  }

  async function refreshUnknownKid(spec: IssuerSpec): Promise<CachedIssuer | null> {
    const previous = cache.get(spec.issuer);
    const previousRefresh = refreshTimes.get(spec.issuer) ?? Number.NEGATIVE_INFINITY;
    const current = now();
    if (current - previousRefresh < REFRESH_INTERVAL_MS) return null;
    refreshTimes.set(spec.issuer, current);
    cache.delete(spec.issuer);
    try { return await load(spec); } catch { return previous ?? null; }
  }

  return {
    async verify(authorization, activity) {
      if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return { ok: false, reason: 'missing token' };
      const token = authorization.replace(/^Bearer\s+/i, '');
      let payload: JWTPayload;
      try { payload = decodeJwt(token); } catch { return { ok: false, reason: 'bad signature' }; }
      if (typeof payload.iss !== 'string') return { ok: false, reason: 'wrong issuer' };
      const spec = issuerSpec(payload.iss, options.tenantId.toLowerCase());
      if (!spec) return { ok: false, reason: 'wrong issuer' };
      let entry: CachedIssuer;
      try { entry = await load(spec); } catch { return { ok: false, reason: 'metadata unavailable' }; }
      let verified: JWTPayload;
      try {
        verified = (await jwtVerify(token, entry.keys, { issuer: spec.issuer, audience: options.appId, algorithms: ['RS256'], clockTolerance: 300, currentDate: new Date(now()) })).payload;
      } catch (error) {
        if (error instanceof errors.JWKSNoMatchingKey) {
          const refreshed = await refreshUnknownKid(spec);
          if (refreshed) {
            try {
              verified = (await jwtVerify(token, refreshed.keys, { issuer: spec.issuer, audience: options.appId, algorithms: ['RS256'], clockTolerance: 300, currentDate: new Date(now()) })).payload;
            } catch (retryError) { return { ok: false, reason: claimReason(retryError) }; }
          } else return { ok: false, reason: 'bad signature' };
        } else return { ok: false, reason: claimReason(error) };
      }
      // Channel tokens carry the conversation's service URL ("serviceurl"; some issuers use "serviceUrl"). Requiring it
      // means a plain app-only token for this bot's audience, which any app in the tenant could obtain, is not enough.
      const claimed = verified.serviceurl ?? verified.serviceUrl;
      if (typeof claimed !== 'string') return { ok: false, reason: 'service url missing' };
      if (claimed !== activity.serviceUrl) return { ok: false, reason: 'service url mismatch' };
      return { ok: true };
    },
  };
}

function claimReason(error: unknown): string {
  if (error instanceof errors.JWTExpired) return 'expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'aud') return 'wrong audience';
    if (error.claim === 'iss') return 'wrong issuer';
    if (error.claim === 'exp' || error.claim === 'nbf') return 'expired';
  }
  return 'bad signature';
}
