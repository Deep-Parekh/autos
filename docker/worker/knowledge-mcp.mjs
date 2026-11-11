import { pathToFileURL } from 'node:url';
import { KNOWLEDGE_MCP_SERVER, KNOWLEDGE_TOOLS, knowledgeCallResponseSchema } from '@autos/contracts';

/**
 * Credential-free stdio MCP server for the read-only Jira/Confluence knowledge tools (docs/atlassian-mcp-plan.md).
 * It forwards each tool call to the host gateway with the per-run bearer token. Only JSON-RPC lines go to stdout;
 * diagnostics go to stderr and never contain the token, the gateway URL or upstream text.
 */
const MAX_LINE_BYTES = 1_048_576;
const CALL_TIMEOUT_MS = 60_000;
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const UNAVAILABLE_TEXT = 'UNAVAILABLE: the knowledge gateway could not be reached';
const TOOL_NAMES = new Set(KNOWLEDGE_TOOLS.map((tool) => tool.name));

const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

function validBaseUrl(url) {
  if (typeof url !== 'string' || !url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return url.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export function createShim({ url, token, fetch: fetchImpl = globalThis.fetch, write, timeoutMs = CALL_TIMEOUT_MS }) {
  const base = validBaseUrl(url);
  const bearer = typeof token === 'string' && token.length > 0 ? token : undefined;
  const send = (message) => write(JSON.stringify(message));

  async function callTool(name, args) {
    if (!base || !bearer) return toolError(UNAVAILABLE_TEXT);
    let parsed;
    try {
      const response = await fetchImpl(`${base}/v1/tools/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(args ?? {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      parsed = knowledgeCallResponseSchema.safeParse(await response.json());
    } catch {
      return toolError(UNAVAILABLE_TEXT);
    }
    if (!parsed.success) return toolError(UNAVAILABLE_TEXT);
    const body = parsed.data;
    if (!body.ok) return toolError(`${body.code}: ${body.message}`);
    const content = [...body.content];
    if (body.truncated === true) content.push({ type: 'text', text: '[result truncated]' });
    return { content, isError: false };
  }

  async function handle(message) {
    const { id, method, params } = message;
    switch (method) {
      case 'initialize':
        return { protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: KNOWLEDGE_MCP_SERVER, version: '1' } };
      case 'ping': return {};
      case 'tools/list': return { tools: KNOWLEDGE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case 'resources/list': return { resources: [] };
      case 'prompts/list': return { prompts: [] };
      case 'tools/call': {
        const name = params?.name;
        if (typeof name !== 'string' || !TOOL_NAMES.has(name)) return errorResponse(id, -32602, 'Unknown tool');
        return callTool(name, params.arguments);
      }
      default: return errorResponse(id, -32601, 'Method not found');
    }
  }

  async function handleLine(line) {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return send(errorResponse(null, -32700, 'Parse error'));
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send(errorResponse(null, -32700, 'Parse error'));
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
      const hasId = message && typeof message === 'object' && !Array.isArray(message) && (typeof message.id === 'string' || typeof message.id === 'number');
      // Responses from the client (no method) and junk without an id get no reply.
      if (hasId && !('result' in message) && !('error' in message)) send(errorResponse(message.id, -32600, 'Invalid Request'));
      return;
    }
    const isRequest = message.id !== undefined && message.id !== null;
    let outcome;
    try {
      outcome = await handle(message);
    } catch {
      outcome = errorResponse(message.id, -32603, 'Internal error');
    }
    if (!isRequest) return;
    send(outcome && outcome.jsonrpc === '2.0' ? outcome : { jsonrpc: '2.0', id: message.id, result: outcome });
  }

  return { handleLine };
}

/** Reads newline-delimited messages from stdin; oversized lines are dropped with a parse error; exits 0 after in-flight calls finish. */
function runStdio() {
  const shim = createShim({
    url: process.env.AUTOS_KNOWLEDGE_URL,
    token: process.env.AUTOS_KNOWLEDGE_TOKEN,
    write: (line) => process.stdout.write(`${line}\n`),
  });
  const inflight = new Set();
  const dispatch = (line) => {
    const task = shim.handleLine(line).catch(() => process.stderr.write('knowledge-mcp: internal error\n')).finally(() => inflight.delete(task));
    inflight.add(task);
  };
  let buffer = '';
  let discarding = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (discarding) discarding = false;
      else dispatch(line);
    }
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = '';
      if (!discarding) {
        discarding = true;
        dispatch('x'.repeat(MAX_LINE_BYTES + 1));
      }
    }
  });
  process.stdin.on('end', async () => {
    if (buffer && !discarding) dispatch(buffer);
    await Promise.allSettled([...inflight]);
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runStdio();
