# Read-only Jira and Confluence access for agents: plan

Status: implemented (all chunks). Tested with fake Atlassian, fake runners and fake CLIs; not yet run against real Atlassian content with real coding CLIs. Operator guide: [knowledge.md](knowledge.md).

Goal: agents can read a ticket's comments, attachments and linked issues, search resolved tickets, and search and read Confluence pages (knowledge base, earlier fixes in other projects) through MCP tools. Nothing can be written to Jira or Confluence, and each installation chooses which Confluence spaces and Jira projects are readable.

Today the controller reads Jira and Confluence itself and copies only the ticket's summary, description and acceptance criteria into the prompt. Agents have no Atlassian access.

## Design in one paragraph

Autos runs its own **knowledge gateway** on the host, next to the controller, where the Atlassian token already lives. It exposes a fixed set of read-only tools. Inside each agent container a tiny **MCP shim** (a stdio MCP server with no credentials) lists those tools to the coding CLI and forwards each call to the gateway over HTTP, using a token that is valid only for that one role run. The gateway checks the allow-list, enforces budgets, calls Atlassian with the existing read-only client, and writes an audit record into the job's artifacts.

```
agent CLI (claude / codex / cursor)        container: no Atlassian credential
   │  MCP over stdio
knowledge-mcp.mjs (shim)                   container: holds only the per-run token
   │  HTTP + per-run bearer token
knowledge gateway (controller process)     host: allow-list, budgets, audit
   │  GET only, existing retry/timeout rules
Jira / Confluence Cloud                    host: Atlassian API token
```

## Why not Atlassian's hosted MCP server

| Option | Why not |
| --- | --- |
| Atlassian Remote MCP server in the agent container | It includes write tools (edit issue, add comment, create page); read-only would depend on three different CLI allow-lists. The user's OAuth login would sit inside a container that reads untrusted ticket text. No per-installation space allow-list, no budget, no audit. |
| Give the container the API token and let agents call REST | Same credential problem, and the agent decides what to call. |
| Only pre-fetch everything into the prompt | Fine for the ticket's own comments, but nobody can pre-fetch "similar fixed bugs" or the right knowledge-base page; that needs search. |
| Gateway speaks MCP over HTTP directly | CLI support for remote MCP differs and changes; stdio MCP is supported by all three. The shim keeps the gateway protocol a plain JSON POST that is easy to test and to secure. |

## Rules

- **Read-only by construction:** the gateway has no write tool, and the Atlassian client it uses only issues GET requests and refuses redirects.
- **Allow-list (per installation, in `config.yaml`):** Jira projects (default: `jira.allowed_projects`), Confluence space keys, and optional Confluence page IDs whose whole page tree is allowed. Everything else is refused, including search results from other spaces. Queries are composed by trusted code; agents never send raw JQL or CQL.
- **Per-run token:** created when a role starts and revoked when it ends; it is bound to the job, ticket and role. It is not an infrastructure credential: it grants only what that role may read.
- **Budgets:** calls per role run, characters per result, characters per role run, attachment size. Over budget returns a clear tool error; the role carries on.
- **Audit:** every call is recorded (tool, target ID, size, outcome) in the job's private artifacts. No content is logged.
- **Untrusted content:** prompts say tool results are data, not instructions. READY_FOR_HUMAN still depends only on checks, QA and review.
- **Off by default.** `knowledge.enabled: true` turns it on.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `jira_get_issue` | `issue_key` | Fields, description, status, resolution, linked issues, attachment list |
| `jira_get_comments` | `issue_key` | Comments (author, date, text) |
| `jira_get_attachment` | `issue_key`, `attachment_id` | Text for text files; the image for PNG/JPEG/GIF/WebP; metadata only for other types |
| `jira_search` | `query`, optional `project`, `resolved_only` | Matching issues in allowed projects (key, summary, status, resolution) |
| `confluence_search` | `query`, optional `space` | Matching pages in allowed spaces and page trees (ID, title, space, excerpt) |
| `confluence_get_page` | `page` (ID or URL) | Title, space, page text |
| `confluence_get_children` | `page_id` | Child pages |

A Confluence page given in an operator note (`autos note KEY "see https://…/pages/123"`) is read with `confluence_get_page`, as long as it is in an allowed space or page tree.

## Configuration

```yaml
knowledge:
  enabled: true
  roles: [swe, qa, reviewer]
  gateway:
    listen_host: 127.0.0.1          # Docker Desktop forwards host.docker.internal to loopback
    port: 8791
    advertise_url: http://host.docker.internal:8791
  jira:
    projects: [WTS, UWE, CMS2]      # optional; default jira.allowed_projects
  confluence:
    spaces: [UAE, HO, CMS, FFE]
    pages: []                        # page IDs; each page and its descendants are allowed
  limits:
    max_calls_per_run: 80
    max_result_chars: 40000
    max_total_chars_per_run: 600000
    max_attachment_bytes: 5242880
    search_results: 10
```

## Chunks

Chunk 0 first; A, C and F are independent of each other and of B, D and E.

| Chunk | Owner | Files |
| --- | --- | --- |
| **0. Contracts:** config section, tool definitions and schemas, `KnowledgeReadPort`, `KnowledgeSessionPort`, `ProviderRequest.knowledge` | Primary | `packages/contracts` |
| **A. Atlassian reads:** issue detail, comments, attachments, issue search, page search, page, children | Sonnet subagent | `packages/atlassian`, `tests/atlassian` |
| **B. Knowledge gateway:** HTTP server, per-run tokens, allow-list, budgets, audit | Primary | `apps/controller/src/knowledge-gateway.ts`, `tests/knowledge` |
| **C. MCP shim:** stdio JSON-RPC server that forwards to the gateway | Sonnet subagent | `docker/worker/knowledge-mcp.mjs`, `tests/knowledge` |
| **D. Runner and adapters:** pass the session to the container; MCP configuration for Claude, Codex and Cursor; tool allow-lists; redaction | Primary | `packages/runner`, `packages/cli-adapters`, `docker/worker` |
| **E. Workflow and runtime:** open and close a session around each role run, prompt section, audit artifact, start the gateway | Primary | `packages/workflow`, `apps/controller/src/runtime.ts` |
| **F. Docs and sample configuration** | Sonnet subagent | `docs/knowledge.md`, `config/*.example.yaml`, `config/pilot.template.yaml` |

## Risks to accept

- **Content goes to the model providers.** Anything an agent reads is sent to Anthropic, OpenAI or Cursor. The allow-list bounds this; list only spaces approved for that use.
- **Agents have outbound internet** (for the provider APIs). A malicious page could tell an agent to send what it read elsewhere. The allow-list, budgets and audit limit and expose this; they do not remove it.
- **Cursor's MCP flags are unverified** until `providers test` passes with a real Cursor CLI, like its other headless flags.
- **Classic API token.** The client calls the site URL directly, which needs a classic (unscoped) token. Read-only is enforced by Autos, not by the token's scopes.

## Not in this phase

- Writing anything to Jira or Confluence.
- Confluence page attachments and comments.
- Pre-loading pinned pages into the prompt (agents fetch them with the tool).
- Embedding or vector search; search uses Jira and Confluence's own text search.
