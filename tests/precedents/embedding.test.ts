import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { AutosError } from '@autos/contracts';
import { DeterministicFakeEmbedding, OllamaEmbedding, validateEmbeddingUrl } from '../../packages/precedents/src/index.js';

let server: Server;
let url: string;
let handler: (req: IncomingMessage, body: string, res: ServerResponse) => void;
const requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: unknown }> = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => { requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: body ? JSON.parse(body) : null }); handler(req, body, res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
beforeEach(() => { requests.length = 0; });

const reply = (status: number, value: unknown) => (_req: IncomingMessage, _body: string, res: ServerResponse) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
const code = (c: string) => (e: unknown) => e instanceof AutosError && e.code === c;

describe('OllamaEmbedding', () => {
  it('posts batches to /api/embed without auth headers and returns float vectors', async () => {
    handler = (_req, body, res) => { const input = (JSON.parse(body) as { input: string[] }).input; reply(200, { model: 'm', embeddings: input.map((_, i) => [i, 1, 0]) })(_req, body, res); };
    const emb = new OllamaEmbedding({ url, model: 'qwen3-embedding:0.6b', dims: 3, batchSize: 2 });
    const out = await emb.embed(['a', 'b', 'c']);
    assert.equal(out.length, 3);
    assert.ok(out[0] instanceof Float32Array);
    assert.deepEqual([...(out[2] as Float32Array)], [0, 1, 0]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((r) => [r.method, r.path]), [['POST', '/api/embed'], ['POST', '/api/embed']]);
    assert.deepEqual(requests[0]?.body, { model: 'qwen3-embedding:0.6b', input: ['a', 'b'] });
    assert.equal(requests[0]?.headers.authorization, undefined);
    assert.deepEqual(emb.model(), { id: 'qwen3-embedding:0.6b', dims: 3 });
  });

  it('rejects dims mismatch, wrong counts and malformed bodies with sanitized errors', async () => {
    const emb = new OllamaEmbedding({ url, model: 'm', dims: 3 });
    handler = reply(200, { embeddings: [[1, 2]] });
    await assert.rejects(emb.embed(['a']), (e: unknown) => code('INVALID_OUTPUT')(e) && /dimension 2/.test((e as Error).message));
    handler = reply(200, { embeddings: [] });
    await assert.rejects(emb.embed(['a']), code('INVALID_OUTPUT'));
    handler = reply(200, '<html>secret upstream page</html>');
    await assert.rejects(emb.embed(['a']), (e: unknown) => code('INVALID_OUTPUT')(e) && !/secret/.test((e as Error).message));
    handler = reply(500, { error: 'secret internal detail' });
    await assert.rejects(emb.embed(['a']), (e: unknown) => code('UPSTREAM')(e) && !/secret/.test((e as Error).message));
    handler = reply(404, { error: 'model not found' });
    await assert.rejects(emb.embed(['a']), code('NOT_FOUND'));
  });

  it('refuses redirects and times out', async () => {
    handler = (_req, _body, res) => { res.writeHead(302, { location: 'http://example.test/steal' }); res.end(); };
    await assert.rejects(new OllamaEmbedding({ url, model: 'm', dims: 3 }).embed(['a']), (e: unknown) => e instanceof AutosError && ['UNAVAILABLE', 'POLICY'].includes(e.code));
    handler = () => { /* never answers */ };
    await assert.rejects(new OllamaEmbedding({ url, model: 'm', dims: 3, timeoutMs: 100 }).embed(['a']), code('TIMEOUT'));
    const ac = new AbortController(); ac.abort();
    await assert.rejects(new OllamaEmbedding({ url, model: 'm', dims: 3 }).embed(['a'], ac.signal), code('CANCELLED'));
  });

  it('accepts only http loopback or single-label service hosts', () => {
    assert.equal(validateEmbeddingUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
    assert.equal(validateEmbeddingUrl('http://localhost:11434/'), 'http://localhost:11434');
    assert.equal(validateEmbeddingUrl('http://[::1]:11434'), 'http://[::1]:11434');
    assert.equal(validateEmbeddingUrl('http://embeddings:11434'), 'http://embeddings:11434');
    for (const bad of ['https://127.0.0.1:11434', 'http://ollama.example.com:11434', 'http://10.0.0.5:11434', 'http://user:pw@localhost:11434', 'http://localhost:11434/api', 'http://localhost:11434/?x=1', 'not a url']) {
      assert.throws(() => new OllamaEmbedding({ url: bad, model: 'm', dims: 3 }), code('INVALID_CONFIG'), bad);
    }
  });
});

describe('DeterministicFakeEmbedding', () => {
  it('is deterministic and groups texts explicitly', async () => {
    const emb = new DeterministicFakeEmbedding({ dims: 32, groups: [{ id: 'coupon', pattern: /coupon/i }] });
    const [a, b, c, a2] = await emb.embed(['coupon negative', 'Coupon twice', 'export hangs', 'coupon negative']);
    const cos = (x: Float32Array, y: Float32Array) => { let d = 0; let nx = 0; let ny = 0; for (let i = 0; i < x.length; i++) { d += (x[i] ?? 0) * (y[i] ?? 0); nx += (x[i] ?? 0) ** 2; ny += (y[i] ?? 0) ** 2; } return d / Math.sqrt(nx * ny); };
    assert.deepEqual([...(a as Float32Array)], [...(a2 as Float32Array)]);
    assert.ok(cos(a as Float32Array, b as Float32Array) > 0.85);
    assert.ok(Math.abs(cos(a as Float32Array, c as Float32Array)) < 0.5);
  });
});
