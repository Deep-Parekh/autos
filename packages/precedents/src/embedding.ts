import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AutosError, type EmbeddingPort } from '@autos/contracts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
/** A single-label Compose service name (no dots), e.g. `embeddings`. */
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,62}$/i;

/**
 * Validates the embedding service URL: plain http on a loopback host or a single-label internal service name,
 * no credentials, path, query or fragment. Returns the origin.
 */
export function validateEmbeddingUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AutosError('INVALID_CONFIG', 'Embedding URL is not a valid URL'); }
  if (url.protocol !== 'http:') throw new AutosError('INVALID_CONFIG', 'Embedding URL must use http on a local host');
  if (url.username || url.password) throw new AutosError('INVALID_CONFIG', 'Embedding URL must not contain credentials');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new AutosError('INVALID_CONFIG', 'Embedding URL must not contain a path, query or fragment');
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host) && !(SERVICE_NAME.test(host) && !/^\d+$/.test(host))) throw new AutosError('INVALID_CONFIG', 'Embedding URL host must be loopback or an internal service name');
  return url.origin;
}

const embedResponseSchema = z.object({ embeddings: z.array(z.array(z.number().finite())) });

export interface OllamaEmbeddingOptions {
  url: string;
  model: string;
  dims: number;
  timeoutMs?: number;
  batchSize?: number;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** EmbeddingPort over Ollama's `POST /api/embed`. Local only; no auth headers; redirects refused; sanitized errors. */
export class OllamaEmbedding implements EmbeddingPort {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: OllamaEmbeddingOptions) {
    this.origin = validateEmbeddingUrl(opts.url);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(opts.model)) throw new AutosError('INVALID_CONFIG', 'Embedding model name is invalid');
    if (!Number.isInteger(opts.dims) || opts.dims < 1 || opts.dims > 8192) throw new AutosError('INVALID_CONFIG', 'Embedding dimension is invalid');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.batchSize = Math.max(1, Math.min(opts.batchSize ?? 32, 512));
    this.fetchImpl = opts.fetch ?? fetch;
  }
  model(): { id: string; dims: number } { return { id: this.opts.model, dims: this.opts.dims }; }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) out.push(...await this.embedBatch(texts.slice(i, i + this.batchSize), signal));
    return out;
  }

  private async embedBatch(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!input.length) return [];
    if (signal?.aborted) throw new AutosError('CANCELLED', 'Embedding request cancelled');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}/api/embed`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.opts.model, input }), redirect: 'error', signal: combined,
      });
    } catch {
      if (signal?.aborted) throw new AutosError('CANCELLED', 'Embedding request cancelled');
      if (timeout.aborted) throw new AutosError('TIMEOUT', 'Embedding service timed out', { retryable: true });
      throw new AutosError('UNAVAILABLE', 'Embedding service is unreachable', { retryable: true });
    }
    let body: string;
    try { body = await response.text(); } catch {
      if (signal?.aborted) throw new AutosError('CANCELLED', 'Embedding request cancelled');
      if (timeout.aborted) throw new AutosError('TIMEOUT', 'Embedding service timed out', { retryable: true });
      throw new AutosError('UPSTREAM', 'Embedding response could not be read', { retryable: true });
    }
    if (!response.ok) {
      if (response.status === 404) throw new AutosError('NOT_FOUND', 'Embedding model is not available on the embedding service');
      if (response.status === 429) throw new AutosError('RATE_LIMIT', 'Embedding service is busy', { retryable: true });
      if (response.status >= 300 && response.status < 400) throw new AutosError('POLICY', 'Embedding service redirect refused');
      throw new AutosError('UPSTREAM', `Embedding service returned HTTP ${response.status}`, { retryable: response.status >= 500 });
    }
    let parsed: z.infer<typeof embedResponseSchema>;
    try { parsed = embedResponseSchema.parse(JSON.parse(body)); } catch { throw new AutosError('INVALID_OUTPUT', 'Embedding response is malformed'); }
    if (parsed.embeddings.length !== input.length) throw new AutosError('INVALID_OUTPUT', 'Embedding response has the wrong number of vectors');
    return parsed.embeddings.map((v) => {
      if (v.length !== this.opts.dims) throw new AutosError('INVALID_OUTPUT', `Embedding dimension ${v.length} does not match configured ${this.opts.dims}`);
      return Float32Array.from(v);
    });
  }
}

/** Deterministic pseudo-random unit-ish vector from a seed string (xorshift over a sha256 seed). */
export function seededVector(seed: string, dims: number): Float32Array {
  const h = createHash('sha256').update(seed).digest();
  let s = h.readUInt32LE(0) || 1;
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = (s / 0xffffffff) * 2 - 1; }
  return out;
}

export interface SimilarityGroup { id: string; pattern: RegExp; weight?: number }

/**
 * Test embedder: each text gets a hash-seeded vector (unrelated texts are ~orthogonal). Texts matching an
 * explicit similarity group share that group's direction, so their cosine is high (weight 4 ⇒ ~0.94).
 */
export class DeterministicFakeEmbedding implements EmbeddingPort {
  calls = 0;
  texts: string[] = [];
  constructor(private readonly opts: { id?: string; dims?: number; groups?: SimilarityGroup[]; fail?: () => Error | null } = {}) {}
  model(): { id: string; dims: number } { return { id: this.opts.id ?? 'fake-embed', dims: this.opts.dims ?? 64 }; }
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (signal?.aborted) throw new AutosError('CANCELLED', 'Embedding request cancelled');
    const failure = this.opts.fail?.(); if (failure) throw failure;
    this.calls++; this.texts.push(...texts);
    const dims = this.model().dims;
    return texts.map((t) => {
      const v = seededVector(t, dims);
      for (const g of this.opts.groups ?? []) {
        if (!g.pattern.test(t)) continue;
        const gv = seededVector(`group:${g.id}`, dims); const w = g.weight ?? 4;
        for (let i = 0; i < dims; i++) v[i] = (v[i] ?? 0) + w * (gv[i] ?? 0);
      }
      return v;
    });
  }
}
