/**
 * Read-only fake Jira/Confluence HTTP surface for the synthetic scenario.
 * TEST FIXTURE ONLY. It emulates exactly the GET endpoints that @autos/atlassian calls and records
 * every request that is not a GET (or targets another host) as a violation so tests can assert zero mutations.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SyntheticTicket {
  key: string;
  project: string;
  summary: string;
  description: string;
  type: string;
  status?: string;
  components?: string[];
  updated?: string;
  comments?: string[];
}

export interface SyntheticMappingRow {
  project: string;
  workspace: string;
  repository: string;
  developmentBranch: string;
  sandboxBranch?: string;
  enabled: string;
}

export interface AtlassianScenario {
  siteOrigin?: string;
  filterId?: string;
  filterName?: string;
  jql?: string;
  /** Issue keys returned by the saved filter, in order. */
  filterKeys: string[];
  tickets: SyntheticTicket[];
  branchMapPageId?: string;
  branchMapVersion?: number;
  mappings: SyntheticMappingRow[];
  /** Search page size; a small value exercises nextPageToken pagination. Default 2. */
  searchPageSize?: number;
}

export interface RecordedRequest { method: string; url: string }
export interface RequestViolation { method: string; url: string; reason: string }

export interface FakeAtlassian {
  fetch: FetchLike;
  /** Every request seen, in order. */
  requests: RecordedRequest[];
  /** Non-GET methods, foreign hosts, and unsupported routes. Must stay empty. */
  violations: RequestViolation[];
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const adf = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Confluence storage-format branch map table matching Confluence_Project_Branch_Mapping_Template.md. */
export function branchMapStorageHtml(rows: SyntheticMappingRow[]): string {
  const header = ['Project Key', 'Bitbucket Workspace', 'Repository Slug', 'Development Branch', 'Sandbox Branch', 'Enabled'].map((name) => `<th>${name}</th>`).join('');
  const body = rows.map((row) => `<tr>${[row.project, row.workspace, row.repository, row.developmentBranch, row.sandboxBranch ?? '', row.enabled].map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
  return `<p>Autos project mapping (synthetic).</p><table><tbody><tr>${header}</tr>${body}</tbody></table>`;
}

function issueBody(ticket: SyntheticTicket) {
  return { id: ticket.key.replace(/\D/g, ''), key: ticket.key, self: 'https://example.atlassian.net/rest/api/3/issue/1', fields: {
    project: { key: ticket.project }, summary: ticket.summary, description: adf(ticket.description),
    issuetype: { name: ticket.type }, status: { name: ticket.status ?? 'Open' }, updated: ticket.updated ?? '2026-11-01T10:00:00.000+0000',
    components: (ticket.components ?? []).map((name) => ({ name })), issuelinks: [],
  } };
}

export function createFakeAtlassianFetch(scenario: AtlassianScenario): FakeAtlassian {
  const origin = scenario.siteOrigin ?? 'https://example.atlassian.net';
  const filterId = scenario.filterId ?? '12345';
  const jql = scenario.jql ?? 'project in (SAMPLE, LEGACY) AND resolution = Unresolved ORDER BY created ASC';
  const pageId = scenario.branchMapPageId ?? '67890';
  const pageSize = Math.max(1, scenario.searchPageSize ?? 2);
  const requests: RecordedRequest[] = [];
  const violations: RequestViolation[] = [];
  const tickets = new Map(scenario.tickets.map((ticket) => [ticket.key, ticket]));

  const fetchLike: FetchLike = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    requests.push({ method, url: `${url.origin}${url.pathname}` });
    const violate = (reason: string, status: number): Response => { violations.push({ method, url: `${url.origin}${url.pathname}`, reason }); return json({ error: reason }, status); };
    if (method !== 'GET') return violate('non-GET request to a read-only service', 405);
    if (url.origin !== origin) return violate('request to an unexpected host', 403);
    const headers = new Headers(init?.headers ?? request?.headers);
    if (!/^Basic /.test(headers.get('authorization') ?? '')) return json({ message: 'unauthorized' }, 401);

    if (url.pathname === `/rest/api/3/filter/${filterId}`) return json({ id: filterId, name: scenario.filterName ?? 'Synthetic Autos intake', jql });
    if (url.pathname === '/rest/api/3/search/jql') {
      if (url.searchParams.get('jql') !== jql) return json({ issues: [], isLast: true });
      const offset = Number(url.searchParams.get('nextPageToken')?.replace(/^page-/, '') ?? 0);
      if (!Number.isInteger(offset) || offset < 0) return json({ message: 'bad token' }, 400);
      const slice = scenario.filterKeys.slice(offset, offset + pageSize);
      const next = offset + pageSize;
      return json(next < scenario.filterKeys.length ? { issues: slice.map((key) => ({ key })), nextPageToken: `page-${next}` } : { issues: slice.map((key) => ({ key })), isLast: true });
    }
    const comments = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]*-\d+)\/comment$/.exec(url.pathname);
    if (comments) {
      const ticket = tickets.get(comments[1]!);
      if (!ticket) return json({ message: 'not found' }, 404);
      const all = (ticket.comments ?? []).map((text, index) => ({ id: `${ticket.key}-c${index + 1}`, body: adf(text) }));
      const startAt = Number(url.searchParams.get('startAt') ?? 0); const maxResults = Number(url.searchParams.get('maxResults') ?? 100);
      return json({ comments: all.slice(startAt, startAt + maxResults), startAt, maxResults, total: all.length });
    }
    const issue = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]*-\d+)$/.exec(url.pathname);
    if (issue) {
      const ticket = tickets.get(issue[1]!);
      return ticket ? json(issueBody(ticket)) : json({ message: 'not found' }, 404);
    }
    if (url.pathname === `/wiki/api/v2/pages/${pageId}`) {
      return json({ id: pageId, version: { number: scenario.branchMapVersion ?? 3 }, body: { storage: { value: branchMapStorageHtml(scenario.mappings) } } });
    }
    return violate('unsupported route', 404);
  };
  return { fetch: fetchLike, requests, violations };
}

/** Marker in a ticket description that makes the fake reviewer fail the first candidate with an actionable finding. */
export const REVIEWER_FAILS_ONCE_MARKER = '[fixture:reviewer-fails-once]';

/** SAMPLE-123 fixable, SAMPLE-124 needs one repair round, SAMPLE-125 is a Story (policy block), LEGACY-9 maps to a disabled repository row. */
export function defaultAtlassianScenario(): AtlassianScenario {
  return {
    filterKeys: ['SAMPLE-125', 'SAMPLE-123', 'SAMPLE-124', 'LEGACY-9'],
    tickets: [
      { key: 'SAMPLE-123', project: 'SAMPLE', type: 'Bug', summary: 'Persist resolved completion status', components: ['tasks'],
        description: 'Completing a task reports success but keeps OPEN. Persist RESOLVED without changing the action result.', comments: ['Reproduced on develop; the JSP shows OPEN after completion.'] },
      { key: 'SAMPLE-124', project: 'SAMPLE', type: 'Bug', summary: 'Completed tasks still show as open (documented rationale required)', components: ['tasks'],
        description: `Completing a task keeps OPEN. Persist RESOLVED; reviewers also require a rationale comment. ${REVIEWER_FAILS_ONCE_MARKER}` },
      { key: 'SAMPLE-125', project: 'SAMPLE', type: 'Story', summary: 'Add task export', description: 'Feature request outside the Bug intake policy.' },
      { key: 'LEGACY-9', project: 'LEGACY', type: 'Bug', summary: 'Legacy portal defect', description: 'Project is mapped but disabled in the branch map.' },
    ],
    mappings: [
      { project: 'SAMPLE', workspace: 'example', repository: 'sample-app', developmentBranch: 'develop', enabled: 'Yes' },
      { project: 'LEGACY', workspace: 'example', repository: 'sample-app', developmentBranch: 'develop', enabled: 'No' },
    ],
  };
}

/** Four fixable SAMPLE bugs (201-204), a Story, and a disabled-mapping ticket, for concurrency scenarios. */
export function parallelAtlassianScenario(): AtlassianScenario {
  const base = defaultAtlassianScenario();
  const fixable = [201, 202, 203, 204].map((n): SyntheticTicket => ({ key: `SAMPLE-${n}`, project: 'SAMPLE', type: 'Bug', summary: `Persist resolved completion status (${n})`, components: ['tasks'],
    description: 'Completing a task reports success but keeps OPEN. Persist RESOLVED without changing the action result.' }));
  return { ...base, tickets: [...fixable, ...base.tickets.filter((t) => t.key === 'SAMPLE-125' || t.key === 'LEGACY-9')], filterKeys: ['SAMPLE-125', 'SAMPLE-201', 'SAMPLE-202', 'LEGACY-9', 'SAMPLE-203', 'SAMPLE-204'] };
}
