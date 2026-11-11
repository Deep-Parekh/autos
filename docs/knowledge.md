# Read-only Jira and Confluence tools for agents

> **Status.** This feature is implemented and tested against fake services only. It has not yet been run against real Atlassian content with real coding CLIs. Treat the first real run as verification, not as proven behaviour. It is off by default.

By default an agent sees only the ticket summary, description and acceptance criteria that the controller copies into its prompt. With the knowledge tools turned on, SWE, QA and reviewer agents can also look things up in Jira and Confluence while they work.

## What agents can and cannot do

| Can | Cannot |
| --- | --- |
| Read a ticket's fields, comments, linked issues and attachments | Write anything to Jira or Confluence: no comments, edits, transitions or page changes |
| Search issues in the allowed Jira projects (for example earlier, already fixed bugs) | Read projects, spaces or pages outside the allow-list, even when a search would find them |
| Search and read Confluence pages in the allowed spaces and page trees | Send raw JQL or CQL; queries are built by Autos |
| List the child pages of an allowed page | Read Confluence page attachments or comments (not in this phase) |

`READY_FOR_HUMAN` still depends only on checks, QA and review. Tool results are reference data, and the prompts say so.

## How it works

Autos runs a **knowledge gateway** on the host inside the controller process, next to the Atlassian token. It offers a fixed set of read-only tools. In each agent container a small MCP shim, with no credentials, lists those tools to the coding CLI and forwards every call to the gateway over HTTP. The call carries a token that is valid for one role run only and is revoked when the run ends. The gateway checks the allow-list and the budgets, reads from Atlassian with the existing GET-only client (no redirects), and writes an audit record. The Atlassian credential never enters an agent container.

```
agent CLI (claude / codex / cursor)        container: no Atlassian credential
   │  MCP over stdio
knowledge-mcp.mjs (shim)                   container: holds only the per-run token
   │  HTTP + per-run bearer token
knowledge gateway (controller process)     host: allow-list, budgets, audit
   │  GET only, existing retry/timeout rules
Jira / Confluence Cloud                    host: Atlassian API token
```

## Turn it on

Add a `knowledge:` section to `config/config.yaml`. Samples are in `config/config.example.yaml` and `config/pilot.template.yaml` (commented out).

```yaml
knowledge:
  enabled: true
  roles: [swe, qa, reviewer]
  confluence:
    spaces: [DOCS, KB]
```

Every key, with its default:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. With `false` (or no section) nothing is started and agents get no tools. |
| `roles` | `[swe, qa, reviewer]` | Roles that get the tools (1 to 3 of `swe`, `qa`, `reviewer`). |
| `gateway.listen_host` | `127.0.0.1` | Address the gateway binds (an IPv4 address or `::1`). See [Networking](#networking). |
| `gateway.port` | `8791` | Gateway port (1024 to 65535). |
| `gateway.advertise_url` | `http://host.docker.internal:8791` | URL agent containers use to reach the gateway. Plain `http` is fine: it stays on the host. |
| `jira.projects` | `jira.allowed_projects` | Readable Jira projects. Omit to reuse the ticket allow-list. |
| `confluence.spaces` | `[]` | Readable Confluence space keys. |
| `confluence.pages` | `[]` | Page IDs; each page and all its descendants are readable. |
| `limits.max_calls_per_run` | `80` | Tool calls per role run (1 to 1000). |
| `limits.max_result_chars` | `40000` | Characters in one result (1000 to 200000). Longer results are truncated. |
| `limits.max_total_chars_per_run` | `600000` | Characters across all results of one role run (1000 to 5000000). |
| `limits.max_attachment_bytes` | `5242880` | Largest attachment that is fetched (1 KiB to 20 MiB). |
| `limits.search_results` | `10` | Hits returned per search (1 to 25). |

With no `confluence.spaces` and no `confluence.pages`, Confluence tools find and read nothing. Jira and Confluence both use the credentials already configured under `jira:` and `confluence:`.

### Find a space key

Open any page of the space in the browser. The key is in the URL: `https://example.atlassian.net/wiki/spaces/DOCS/overview` has key `DOCS`. Personal spaces start with `~` (for example `~60fee4eba539cb00681d1309`); quote them in YAML.

### Find a page ID

Open the page. The ID is the number after `/pages/`: `…/wiki/spaces/DOCS/pages/3083534337/Release+notes` has ID `3083534337`.

### Allow one page tree instead of a whole space

List the page ID under `confluence.pages` and leave the space out of `confluence.spaces`:

```yaml
knowledge:
  enabled: true
  confluence:
    spaces: []
    pages: ['3083534337']
```

That page and everything below it can be searched and read; the rest of its space cannot.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `jira_get_issue` | `issue_key` | Fields, description, status, resolution, linked issues, attachment list |
| `jira_get_comments` | `issue_key` | Comments (author, date, text), oldest first |
| `jira_get_attachment` | `issue_key`, `attachment_id` | Text for text files; the image for PNG, JPEG, GIF and WebP; metadata only for other types |
| `jira_search` | `query`, optional `project`, `resolved_only` | Matching issues in allowed projects (key, summary, status, resolution) |
| `confluence_search` | `query`, optional `space` | Matching pages in allowed spaces and page trees (ID, title, space, excerpt) |
| `confluence_get_page` | `page` (ID or page URL) | Title, space, page text |
| `confluence_get_children` | `page_id` | Child pages |

The MCP server is named `autos_knowledge`.

## Point an agent at a page

Agents fetch pages themselves; nothing is pre-loaded. To steer one, put the page URL in an operator note:

```sh
autos note KEY --swe "Follow the design in https://example.atlassian.net/wiki/spaces/DOCS/pages/3083534337/Design"
```

Use `--all` to tell every role. The agent reads it with `confluence_get_page` if the page is in an allowed space or page tree; otherwise the call is refused with `FORBIDDEN`.

## What is recorded

Every tool call is recorded in the job's private artifacts as `knowledge-audit.json`. Each entry holds the time, tool, target (issue key, page ID or attachment ID; for searches only the length of the query), outcome (`OK`, `INVALID_INPUT`, `FORBIDDEN`, `NOT_FOUND`, `BUDGET`, `UNAVAILABLE`), characters returned and elapsed milliseconds. Content, query text, results and tokens are never written to the audit file or the logs.

## Limits

Each role run has a call budget, a total character budget, a per-result character cap and an attachment size cap (see the table above). A result above the cap is truncated and marked as truncated. When a budget is used up, the tool returns a clear `BUDGET` error to the agent and the role carries on without further lookups. Neither a budget error nor a refused call fails the job by itself.

## Networking

Agent containers reach the gateway at `advertise_url`.

- **Docker Desktop (macOS):** the defaults work. `host.docker.internal` reaches the host's loopback, so the gateway stays bound to `127.0.0.1`.
- **Linux:** `host.docker.internal` does not reach loopback. Bind `gateway.listen_host` to the Docker bridge gateway address (usually `172.17.0.1`; check with `docker network inspect bridge`, or the address of the network the agent containers use) and set `gateway.advertise_url` to `http://<that address>:8791`. Do not bind `0.0.0.0`. Make sure the host firewall allows that port from the containers only.

## After enabling

1. Rebuild the worker images, because the shim is baked into them (see [local-pilot.md](local-pilot.md#2-build-images)).
2. Restart the supervisor.
3. Restart the controller. The gateway starts with it.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| The agent has no `autos_knowledge` tools | `knowledge.enabled` is `false`, the role is not in `roles`, the worker image was not rebuilt, or the supervisor or controller was not restarted. Check `knowledge-audit.json` is present for the job; the Cursor MCP flags are also unverified. |
| `FORBIDDEN` for a space or project | It is not in `confluence.spaces`, `confluence.pages` (or the page is outside that tree), or `jira.projects` / `jira.allowed_projects`. Add it if it is approved for this use and restart the controller. |
| `UNAVAILABLE` | The gateway or Atlassian could not be reached or timed out. For the gateway, check `listen_host`, `advertise_url` and the firewall (see Networking). For Atlassian, check the site URL and try again. |
| Atlassian answers 401 | The read client calls the site URL directly, which needs a classic (unscoped) API token, not a scoped one. Create one at id.atlassian.com and update the token in `.env`. |
| `BUDGET` | The role used its calls or characters. Raise the `limits` if that is intended. |
| `NOT_FOUND` | Wrong ID, or the attachment does not belong to that issue. |

## Risks to accept

- **Content goes to the model providers.** Anything an agent reads is sent to Anthropic, OpenAI or Cursor. List only spaces and projects approved for that use.
- **Agents have outbound internet** (the provider APIs need it). A malicious page could instruct an agent to send what it read elsewhere. The allow-list, budgets and audit limit and expose this; they do not remove it.
- **Cursor's MCP flags are unverified** until `providers test` passes with a real Cursor CLI, like its other headless flags.
- **Read-only is enforced by Autos, not by the token.** A classic API token carries the user's full permissions; the client simply issues no writes.
