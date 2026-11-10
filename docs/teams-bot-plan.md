# Teams bot (phase 2): plan

Goal: less technical users talk to Autos from Teams instead of the CLI. They mention the bot with a Jira link and instructions, fill a form, or press buttons on cards (Revise, Retry, Close, Cancel). The controller keeps listening on loopback only.

```
Teams ──HTTPS──> tunnel / reverse proxy ──> autos teams bot (127.0.0.1:3978, POST /api/messages)
                                               │ verifies the Bot Framework JWT, allowlists the sender,
                                               │ parses the command, calls the controller API with the
                                               │ operator token, replies through the Bot Connector API
                                               └──> controller (127.0.0.1:8787)
```

Out of scope for phase 2: proactive notifications through the bot (the webhook relay keeps doing that), Action.Execute / universal actions, multi-tenant bots, and any Jira/Git action the controller API does not already offer.

## Fixed decisions

- **Process:** `autos teams bot` is a CLI command running a `node:http` server on `teams_bot.listen_host:port`. It accepts only `POST /api/messages` (body ≤ 256 KiB, JSON) and `GET /healthz`. Everything else gets a 404.
- **Identity:** a single-tenant Azure Bot whose Microsoft App ID is the Entra app `teams_bot.app_id` in `teams_bot.tenant_id`. The client secret is read from `teams_bot.client_secret_env`.
- **Inbound auth (chunk A):** each request must carry `Authorization: Bearer <JWT>` signed with RS256 by a key from the OpenID metadata of one of the accepted issuers:
  - Bot Framework: metadata at `https://login.botframework.com/v1/.well-known/openidconfiguration`, issuer `https://api.botframework.com`.
  - Your tenant, Entra v1: issuer `https://sts.windows.net/{tenant}/`, metadata at `https://login.microsoftonline.com/{tenant}/.well-known/openid-configuration`.
  - Your tenant, Entra v2: issuer `https://login.microsoftonline.com/{tenant}/v2.0`, metadata at `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`.

  The token's `aud` must equal `app_id`. `nbf` and `exp` are enforced with 5 minutes of clock skew. When the token has a `serviceUrl` claim, it must equal `activity.serviceUrl`. Metadata and JWKS are cached for 24 h and refreshed early when a token names an unknown `kid`, at most once per 5 minutes.
- **Outbound auth:** a client-credentials token with scope `https://api.botframework.com/.default` from `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`. Use `EntraTokenSource` from `apps/cli/src/teams.ts` with `scope`.
- **Who may act:** `activity.from.aadObjectId` must be in `teams_bot.allowed_users`, compared case-insensitively. The tenant (`conversation.tenantId` or `channelData.tenant.id`) must equal `tenant_id`. Anyone else gets one short refusal and nothing runs.
- **Audit:** controller calls send `X-Autos-Operator: teams:<aadObjectId>`.
- **Destructive actions:** `cancel` and `close` need `confirmed: true`, which only a button on a confirmation card sets. Typed `close`/`cancel` commands reply with that confirmation card.
- **Secrets:** errors, logs and replies never contain tokens, the client secret, Authorization headers, raw upstream bodies or full service URLs. Logs carry the activity id, the command kind, the issue key and the result.

## Chunks

Chunks A–D are independent and can run in parallel. Each owns only its listed files, builds on `apps/cli/src/teams-bot/types.ts` (do not edit it) and adds no dependencies (`jose` and `zod` are already available to `apps/cli`). Each runs `npm test -- tests/interfaces/<its test file>` and `npm run typecheck`. Tests use fakes only: no network, no real Teams or Entra.

### A. Inbound JWT verification
Files: `apps/cli/src/teams-bot/auth.ts`, `tests/interfaces/teams-bot-auth.test.ts`.

```ts
export interface BotAuthOptions { appId: string; tenantId: string; fetch?: FetchLike; now?: () => number }
export interface BotAuthenticator { verify(authorization: string | undefined, activity: Activity): Promise<{ ok: true } | { ok: false; reason: string }> }
export function createBotAuthenticator(options: BotAuthOptions): BotAuthenticator;
```
Implement the "Inbound auth" decision above with `jose` (`jwtVerify` + `createLocalJWKSet`, with JWKS fetched through the injected `fetch` so tests stay offline). Metadata and JWKS fetches use `redirect: 'error'` and a 10 s timeout. `reason` is a short fixed phrase (`missing token`, `bad signature`, `wrong audience`, `wrong issuer`, `expired`, `service url mismatch`, `metadata unavailable`), never token contents. Tests generate RS256 key pairs with `jose.generateKeyPair` and serve fake metadata and JWKS. Cover:
- each accepted issuer;
- wrong audience, wrong issuer, expired, and a token signed by an unknown key;
- the `serviceUrl` claim mismatch;
- a missing or non-Bearer header;
- caching (one metadata fetch for many verifications) and the throttled refresh on an unknown `kid`.

### B. Command parsing
Files: `apps/cli/src/teams-bot/commands.ts`, `tests/interfaces/teams-bot-commands.test.ts`.

```ts
export function parseCommandText(text: string, ctx: ParseContext): ParseResult;
export function parseCardSubmit(value: unknown, ctx: ParseContext): ParseResult;
export function extractIssueKey(input: string, ctx: ParseContext): string | null;
```
- **Cleaning text:** strip `<at>…</at>` mentions and other HTML tags. Decode `&amp; &lt; &gt; &quot; &#39; &nbsp;`. Collapse whitespace, but keep newlines inside notes.
- **Grammar:** case-insensitive verb first; `KEY` is an issue key or a Jira browse link.
  - `help`
  - `run` alone → `run_form`
  - `run KEY [dry run|--dry-run] [notes…]`
  - `status`
  - `show KEY`
  - `note KEY [swe:|qa:|reviewer:|all:] text… [hold]`
  - `release KEY`
  - `revise KEY [roles swe,qa] text…`
  - `retry JOB_ID`
  - `cancel JOB_ID`
  - `close KEY merged|abandoned`
- **Role prefixes** (`swe:`, `qa:`, `reviewer:`, `all:`) at the start of a line send the text after them to that role. `all:` sends it to every role. Text without a prefix goes to `swe`.
- **Issue keys:** `extractIssueKey` accepts `KEY`, or a URL on `jiraSiteUrl`'s exact host with path `/browse/KEY` (query strings allowed). It returns null for other hosts, for keys outside `allowedProjects`, and for malformed keys. Keys must match `^[A-Z][A-Z0-9]*-[1-9][0-9]*$` after upper-casing.
- **Job IDs** are UUIDs.
- **Limits:** a note over `maxNoteChars` is refused with a message giving the limit. Control characters other than newline and tab are removed.
- **Typed confirmations:** `close` and `cancel` from text always give `confirmed: false`.
- **Card submits:** `parseCardSubmit` validates with `cardSubmitSchema` and maps fields to the same commands. For example, `run` with `issue` and `swe`/`qa`/`reviewer` becomes notes, and `dry_run: 'true'` sets `dryRun: true`. Anything that does not have `autos: 'v1'` is refused.
- **Errors:** refusal messages are short, and they quote at most 40 characters of user input (sanitized).
- **Tests:** every verb, links versus keys, foreign hosts, disallowed projects, the role prefixes, the limits, the HTML entities, and card submits.

### C. Adaptive Cards
Files: `apps/cli/src/teams-bot/cards.ts`, `tests/interfaces/teams-bot-cards.test.ts`.

```ts
export function helpCard(): AdaptiveCard;
export function runFormCard(options?: { issueKey?: string }): AdaptiveCard;
export function jobCard(job: JobRecord, options: { jiraSiteUrl: string; heading?: string }): AdaptiveCard;
export function statusCard(status: unknown): AdaptiveCard;          // GET /v1/status JSON; read defensively
export function confirmCard(command: Extract<BotCommand, { kind: 'close' | 'cancel' }>): AdaptiveCard;
export function messageCard(title: string, lines?: string[], tone?: 'good' | 'warning' | 'attention' | 'default'): AdaptiveCard;
```
All cards are Adaptive Card 1.4 (`$schema`, `type`, `version: '1.4'`, `msteams: { width: 'Full' }`). Every Action.Submit carries `data` that satisfies `cardSubmitSchema`. Text from jobs or users goes through a sanitizer that removes control characters, removes markdown link and emphasis syntax (`[ ] * \` < >`) and truncates.
- **`runFormCard`:**
  - fields: `Input.Text` `issue` ("Jira link or key", required), multiline `swe` / `qa` / `reviewer`, and `Input.Toggle` `dry_run` (`valueOn: 'true'`, `valueOff: 'false'`);
  - Submit button: `{ autos: 'v1', action: 'run' }`.
- **`jobCard`:**
  - title by state, then facts: job, issue, state, branch, commit (12 chars), repair rounds, and the blocked code and reason;
  - always an Open in Jira button (`browse/KEY` on `jiraSiteUrl`).
- **Buttons by state:**

  | State | Buttons |
  |---|---|
  | `READY_FOR_HUMAN` | **Revise**: an `Action.ShowCard` holding a `note` Input.Text and a Submit `{action:'revise', issue}`. **Close as merged**, **Close as abandoned**: Submit `{action:'close', issue, resolution}`, with no `confirmed`. |
  | `BLOCKED` / `CANCELLED` | **Retry** `{action:'retry', job_id}`, **Revise** |
  | Active (`QUEUED` … `REVISING`, `PAUSED`) | **Cancel** `{action:'cancel', job_id}` |

- **`confirmCard`:** "Yes, close KEY as merged" / "Yes, cancel" with `confirmed: true`, plus a "No" that only says nothing changed (a Submit with `action: 'status'`).
- **`statusCard`:** running, paused and queued counts; auto poll on or off; active jobs (issue key and state, at most 10); provider-limit gate.
- **Tests:** schema shape, every submit's data passes `cardSubmitSchema`, buttons per state, sanitizing, and no `confirmed: true` anywhere except `confirmCard`.

### D. Bot Connector client
Files: `apps/cli/src/teams-bot/connector.ts`, `tests/interfaces/teams-bot-connector.test.ts`.

```ts
export function parseServiceUrl(raw: string): URL;                  // throws AutosError('POLICY', …) when not allowed
export function conversationRef(activity: Activity): ConversationRef;
export interface ConnectorOptions { tokens: { token(signal?: AbortSignal): Promise<string>; invalidate(): void }; fetch?: FetchLike; retryDelayMs?: number }
export class ConnectorClient {
  constructor(options: ConnectorOptions);
  reply(activity: Activity, message: OutgoingMessage): Promise<{ ok: boolean; status: number | null }>;
  send(ref: ConversationRef, message: OutgoingMessage): Promise<{ ok: boolean; status: number | null; activityId?: string }>;
  update(ref: ConversationRef, activityId: string, message: OutgoingMessage): Promise<{ ok: boolean; status: number | null }>;
}
```
- **Allowed service URLs:** `https` only, no credentials, and a host of `smba.trafficmanager.net` or one ending in `.botframework.com`, `.teams.microsoft.com` or `.teams.microsoft.us`.
- **Endpoints:**
  - `reply`: `POST {serviceUrl}/v3/conversations/{id}/activities/{activity.id}`
  - `send`: `POST …/v3/conversations/{id}/activities`
  - `update`: `PUT …/activities/{activityId}`

  Encode the IDs with `encodeURIComponent`.
- **Body:** `{ type: 'message', text?, attachments?: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] }`.
- **Delivery:**
  - send `Authorization: Bearer` from `tokens`, with `redirect: 'error'` and a 15 s timeout;
  - on a 401, invalidate the token and retry once;
  - retry 429 / 5xx / network errors up to 3 attempts, honouring `Retry-After` (cap 30 s);
  - other statuses fail at once.
- **Results:** carry only the status (plus the new activity id from `send`'s JSON `{ id }`).
- **Tests:** a fake fetch records each request. Cover URL building and encoding, the service-URL allowlist, the 401 refresh, the retries, and that the token is never present in returned values or errors.

### E. Server, controller actions and CLI wiring (primary agent, after A–D)
Files:
- `apps/cli/src/teams-bot/actions.ts`: `BotCommand` → controller API calls and the reply message;
- `apps/cli/src/teams-bot/server.ts`: the HTTP server, auth, allowlist and dispatch;
- `apps/cli/src/index.ts`: the `teams bot` command and help text;
- `tests/interfaces/teams-bot.test.ts`: end to end with a fake controller, fake Entra and a fake connector.

Behaviour:
- **Request handling:** reply 200 at once, then process the activity. Bot Framework retries slow requests, so remember the last 500 activity IDs to drop duplicates.
- **Activities:** a `message` with text or a card value runs a command. A `conversationUpdate` that adds the bot gets the help card. Other activity types are ignored.

### F. Teams app package and docs
Files:
- `teams-app/manifest.template.json`;
- `scripts/teams-app-package.ts`;
- `tests/interfaces/teams-app-package.test.ts`;
- `docs/teams-bot.md`.

**Manifest:** manifest schema 1.17 with a placeholder `{{APP_ID}}`. One bot with `personal` and `team` scopes and `supportsFiles: false`. `validDomains: []`. Short and full descriptions. Commands: `help`, `run`, `status`, `show`.

**Packaging script:**
- reads `--config` (`teams_bot.app_id`), substitutes the app ID and writes `artifacts/teams-app/autos-teams-app.zip`;
- the zip holds `manifest.json`, `color.png` (192×192) and `outline.png` (32×32 white on transparent);
- it generates the icons itself as PNGs (`zlib.deflateSync` plus CRC32 from `zlib.crc32`);
- it writes a store-only zip in plain Node, with no dependencies.

Tests unzip the result with a small reader in the test and check the manifest fields and the PNG signatures.

**`docs/teams-bot.md`** is the setup guide:
1. Create the Azure Bot (single tenant, the existing Entra app or a new one) and enable the Microsoft Teams channel.
2. Set a client secret.
3. Set the messaging endpoint `https://<tunnel host>/api/messages`.
4. Run a tunnel to `127.0.0.1:3978`: Microsoft Dev Tunnels with anonymous access to that one port only, or Cloudflare Tunnel.
5. Fill `teams_bot` in the config, with `allowed_users` holding your Entra object ID (Entra admin center → Users → you → Object ID).
6. Build the zip and upload it in Teams → Apps → Manage your apps → Upload a custom app.
7. Start `autos teams bot` next to the controller.

The guide also gives the command reference and the security notes.

## Integration and verification (primary agent)
1. Review A–D against this plan, then write E and F's wiring.
2. Run `npm run check` in the `teams-integration` worktree.
3. Commit on `teams-integration`; nothing is merged or pushed without the user.
