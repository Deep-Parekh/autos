import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  codeOverlap, computeTermStats, extractCodeIdentifiers, extractDefectStatement, extractErrorSignatures, ftsMatchExpression, keywordTerms, learnTemplates,
  logTemplate, normalizeEndpoint, prepareIssue, redactSecrets, splitWords, stripTemplates,
} from '../../packages/precedents/src/index.js';
import { issue } from './fixtures.js';

describe('error signatures', () => {
  const javaTrace = `Caused by: com.acme.pricing.PricingRuleException: rule not found
\tat com.acme.pricing.PricingEngine.apply(PricingEngine.java:118)
\tat com.acme.pricing.PricingEngine$$EnhancerBySpringCGLIB$$a1b2c3.apply(<generated>)
\tat org.springframework.aop.framework.CglibAopProxy.intercept(CglibAopProxy.java:688)
\tat com.acme.order.OrderService.lambda$price$3(OrderService.java:77)
\tat com.acme.order.OrderService.price(OrderService.java:42)
\tat java.base/java.lang.Thread.run(Thread.java:833)`;

  it('extracts Java exception classes and a line-number-free stack signature', () => {
    const sigs = extractErrorSignatures(javaTrace);
    assert.ok(sigs.some((s) => s.key === 'exc:PricingRuleException' && s.strong));
    const stack = sigs.find((s) => s.kind === 'stack');
    assert.ok(stack);
    assert.match(stack.display, /^com\.acme\.pricing\.PricingEngine\.apply < /);
    assert.doesNotMatch(stack.display, /\d{2,}|springframework/);
    const moved = javaTrace.replace(/:118\)/, ':121)').replace(/:42\)/, ':45)');
    assert.equal(extractErrorSignatures(moved).find((s) => s.kind === 'stack')?.key, stack.key, 'line numbers do not change the key');
  });

  it('extracts JS stack frames without hashes or line numbers', () => {
    const js = `TypeError: Cannot read properties of undefined (reading 'total')
    at OrderList.render (webpack:///./src/components/OrderList.tsx:42:13)
    at renderWithHooks (/app/node_modules/react-dom/cjs/react-dom.development.js:14985:18)
    at computeTotals (https://cdn.example.test/static/js/main.3f9a2b1c.js:1:2345)`;
    const sigs = extractErrorSignatures(js);
    const exc = sigs.find((s) => s.key === 'exc:TypeError');
    assert.ok(exc && !exc.strong, 'generic exceptions are weak');
    const stack = sigs.find((s) => s.kind === 'stack');
    assert.equal(stack?.display, 'OrderList.render@OrderList.tsx < computeTotals@main.js');
  });

  it('extracts HTTP status with normalized endpoints, and error codes', () => {
    const sigs = extractErrorSignatures('POST https://shop.example.test/api/orders/12345/items?debug=1 returned HTTP 500\nDB said ORA-00942 and error code: PAY_LIMIT_EXCEEDED');
    assert.ok(sigs.some((s) => s.key === 'http:500 /api/orders/{id}/items' && s.strong));
    assert.ok(sigs.some((s) => s.key === 'code:ORA-00942'));
    assert.ok(sigs.some((s) => s.key === 'code:PAY_LIMIT_EXCEEDED'));
    const bare = extractErrorSignatures('the page shows status code 404 sometimes');
    assert.deepEqual(bare.map((s) => [s.key, s.strong]), [['http:404', false]]);
  });

  it('normalizes endpoints and log templates', () => {
    assert.equal(normalizeEndpoint('/API/Orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301/Lines/7'), '/api/orders/{id}/lines/{id}');
    assert.equal(normalizeEndpoint('relative/path'), null);
    assert.equal(logTemplate('2026-11-01 10:22:33,123 [http-nio-8080-exec-5] job 991 failed for tenant "acme" after 3 retries id=0xdeadbeef'),
      '[<thread>] job <n> failed for tenant <str> after <n> retries id=<hex>');
    const a = extractErrorSignatures('2026-11-01T10:22:33Z ERROR Invoice 4411 export failed after 3 retries');
    const b = extractErrorSignatures('2026-10-02T08:00:01Z ERROR Invoice 87 export failed after 5 retries');
    assert.equal(a.find((s) => s.kind === 'log')?.key, b.find((s) => s.kind === 'log')?.key);
  });
});

describe('redaction', () => {
  const cases: Array<[string, RegExp, RegExp]> = [
    ['Authorization: Bearer abc.def.ghi1234567', /Authorization: Bearer \[REDACTED\]/, /abc\.def/],
    ['curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="', /Basic \[REDACTED\]/, /dXNlcjpw/],
    ['clone https://bob:hunter2@git.example.test/repo.git', /https:\/\/\[REDACTED\]@git/, /hunter2/],
    ['see https://app.example.test/login?token=s3cr3t&x=1 now', /login\?\[REDACTED\] now/, /s3cr3t/],
    ['password=Sup3rS3cret! and api_key: "k-123"', /password=\[REDACTED\] and api_key: \[REDACTED\]/, /Sup3r|k-123/],
    ['ping alice.smith@example.com please', /ping \[EMAIL\] please/, /alice/],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', /\[REDACTED/, /ghp_/],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', /\[REDACTED_JWT\]/, /eyJhbGci/],
  ];
  for (const [input, keep, gone] of cases) it(`redacts: ${input.slice(0, 30)}`, () => {
    const out = redactSecrets(input);
    assert.match(out, keep); assert.doesNotMatch(out, gone);
    assert.equal(redactSecrets(out), out, 'idempotent');
  });
  it('keeps commit shas and file paths', () => {
    const text = 'fixed in 3f2a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b src/main/java/com/acme/order/OrderService.java';
    assert.equal(redactSecrets(text), text);
  });
});

describe('templates and stoplist', () => {
  it('learns lines present in more than 20% of a project\'s descriptions and strips them', () => {
    const descs = Array.from({ length: 10 }, (_, i) => `h2. Steps to reproduce\n1. open order ${i}\n*Environment:* Chrome ${100 + i}\nReported via portal\n${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'][i]} widget is unique`);
    const t = learnTemplates('PROJA', descs);
    assert.ok(t.lines.includes('steps to reproduce'));
    assert.ok(t.lines.includes('environment: chrome #'), t.lines.join('|'));
    assert.ok(t.lines.includes('reported via portal'));
    assert.ok(!t.lines.some((l) => l.includes('widget')));
    assert.ok(t.hash);
    const stripped = stripTemplates('h2. Steps to reproduce\nThe cart total is negative\nReported via portal', t);
    assert.equal(stripped, 'The cart total is negative');
    assert.deepEqual(learnTemplates('X', descs.slice(0, 3)).lines, [], 'too few descriptions');
  });

  it('builds a corpus stoplist from document frequency and project jargon', () => {
    const docs = [
      ...Array.from({ length: 30 }, (_, i) => ({ project: 'PROJA', text: `Acmeshop checkout zephyr widget${i} problem${i}` })),
      ...Array.from({ length: 30 }, (_, i) => ({ project: 'PROJB', text: `Acmeshop catalog item${i} unique${i}` })),
    ];
    const stats = computeTermStats(docs);
    assert.ok(stats.stoplist.has('acmeshop'), 'global high-df term');
    assert.ok(stats.stoplist.has('zephyr'), 'one project\'s jargon');
    assert.ok(!stats.stoplist.has('widget3'));
    assert.deepEqual(keywordTerms('Acmeshop zephyr widget3 the checkout', stats), ['widget3']);
    assert.equal(ftsMatchExpression(['a"b', 'NEAR', 'x']), '"a""b" OR "NEAR" OR "x"');
    assert.equal(ftsMatchExpression([]), null);
  });
});

describe('defect statement and identifiers', () => {
  it('uses headings first and stays compact', () => {
    const d = extractDefectStatement({ summary: 'Discount applied twice at checkout', description: 'h3. Actual result\nThe discount is applied twice when the coupon is re-entered.\n*Expected result:* Applied once.\nh3. Steps to reproduce\n1. add coupon\n' + 'filler '.repeat(500) });
    assert.match(d.observed, /applied twice/);
    assert.equal(d.expected, 'Applied once.');
    assert.ok(d.text.length <= 1200);
    assert.match(d.text, /^Summary: Discount applied twice/);
  });
  it('falls back to sentence patterns', () => {
    const d = extractDefectStatement({ summary: 'Export', description: 'When I click export on the Invoice report page nothing happens. It should download a CSV. Thanks.' });
    assert.match(d.observed, /nothing happens/);
    assert.match(d.expected, /should download/);
    assert.match(d.where, /Invoice report/);
  });
  it('extracts code identifiers', () => {
    const refs = extractCodeIdentifiers('See src/main/java/com/acme/order/OrderService.java and PricingEngine#apply(rule). Config pricing.rules.cache-ttl is wrong. SELECT * FROM order_lines WHERE x; calls computeTotals(x). Visit www.example.com.');
    const has = (kind: string, value: string) => refs.some((r) => r.kind === kind && r.value === value);
    assert.ok(has('path', 'src/main/java/com/acme/order/OrderService.java'));
    assert.ok(has('class', 'PricingEngine'));
    assert.ok(has('method', 'PricingEngine.apply'));
    assert.ok(has('method', 'computeTotals'));
    assert.ok(has('config', 'pricing.rules.cache-ttl'));
    assert.ok(has('table', 'order_lines'));
    assert.ok(!refs.some((r) => r.value.includes('example.com')));
    assert.deepEqual(codeOverlap([{ kind: 'class', value: 'OrderService' }], ['src/main/java/com/acme/order/OrderService.java', 'src/index.ts']), ['src/main/java/com/acme/order/OrderService.java']);
    assert.deepEqual(codeOverlap([{ kind: 'path', value: 'src/index.ts' }], ['web/src/index.ts']), ['web/src/index.ts']);
    assert.deepEqual(codeOverlap([{ kind: 'path', value: 'a/index.ts' }], ['b/index.ts']), [], 'generic basenames need the path');
  });
});

describe('chunking and preparation', () => {
  it('chunks defect/head/comments/error and caps comments', () => {
    const comments = Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1), author_is_app: i === 3, created: '2026-01-01T00:00:00.000Z', body: `comment number ${i}` }));
    const p = prepareIssue(issue({ id: '1', key: 'PROJA-1', description: `${'word '.repeat(700)}\nNullPointerException in OrderService and PricingRuleException`, comments }));
    const kinds = p.chunks.map((c) => c.kind);
    assert.equal(kinds.filter((k) => k === 'defect').length, 1);
    assert.equal(kinds.filter((k) => k === 'head').length, 3);
    assert.equal(kinds.filter((k) => k === 'comment').length, 35);
    assert.ok(!p.chunks.some((c) => c.text === 'comment number 3'), 'app comments excluded');
    assert.ok(p.chunks.some((c) => c.text === 'comment number 49'));
    assert.ok(kinds.includes('error'));
    assert.deepEqual(splitWords('a b c d e', 2, 1), ['a b', 'b c', 'c d', 'd e']);
  });
  it('content hash ignores updated_at and redacts before storing', () => {
    const a = prepareIssue(issue({ id: '1', key: 'PROJA-1', description: 'password=abc123 broken' }));
    const b = prepareIssue(issue({ id: '1', key: 'PROJA-1', description: 'password=abc123 broken', updated_at: '2026-11-11T00:00:00.000Z' }));
    assert.equal(a.content_hash, b.content_hash);
    assert.doesNotMatch(a.issue.description, /abc123/);
    assert.ok(!a.defect_public.includes('comment'));
  });
});
