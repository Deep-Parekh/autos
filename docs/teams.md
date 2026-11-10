# Teams notifications

`autos teams relay` posts a card to a Teams channel or chat when an attempt finishes, is blocked or pauses. Communication is one way: outbound HTTPS from your machine to a Teams Workflows webhook. Nothing is exposed, and the controller keeps listening on loopback only. Commands from Teams (revise, pin a tier, close) need a Teams bot; that is a later phase.

## 1. Create the webhook in Teams

1. In the target channel (or chat), open **Workflows** and choose the template **Post to a channel when a webhook request is received** (in a chat: *Post to a chat when a webhook request is received*).
2. Finish the wizard and copy the URL it shows. It contains a signature (`sig=…`), so treat it like a password.
3. Put it in `.env`:
   ```sh
   AUTOS_TEAMS_WEBHOOK_URL=https://...logic.azure.com/workflows/.../invoke?api-version=...&sig=...
   ```
   Autos accepts only credential-free `https` URLs on Workflows hosts (`*.logic.azure.com`, `*.api.powerplatform.com`). The retired Office 365 connector URLs (`*.webhook.office.com`) are refused.

### Tenants that require sign-in

If the trigger's **Who can trigger the flow** cannot be set to **Anyone** (many tenants block it), the URL has no `sig=` and an unsigned post gets HTTP 401. Sign the relay in with its own Microsoft Entra ID app instead:

1. **Register the app.** In portal.azure.com, open **Microsoft Entra ID** → **App registrations** → **New registration**. Name it, for example `autos-teams-relay`, choose single tenant, leave the redirect URI empty and register. Copy the **Application (client) ID** and the **Directory (tenant) ID**.
2. **Create a secret.** Under **Certificates & secrets** → **New client secret**, set an expiry and copy the secret **Value** (it is shown once). Put it in `.env`:
   ```sh
   AUTOS_TEAMS_CLIENT_SECRET='...'
   ```
   Try it first without adding API permissions: the app only has to obtain a token for Power Automate. Some guides also add **API permissions** → **Power Automate** with admin consent. Add it only if `teams test` reports a sign-in error that mentions consent or permissions.
3. **Allow the app on the trigger.** In **Microsoft Entra ID** → **Enterprise applications**, find the app and copy its **Object ID**. This is not the object ID on the App registration page. In the workflow, open the trigger, set **Who can trigger the flow** to **Specific users in my tenant**, add that object ID to **Allowed users** and save. **Any user in my tenant** also works, but it lets every account in the tenant post to the channel.
4. **Copy the URL into `.env`, in single quotes** (it contains `&`, which the shell would otherwise cut at):
   ```sh
   AUTOS_TEAMS_WEBHOOK_URL='https://...powerplatform.com:443/powerautomate/automations/direct/.../invoke?api-version=1'
   ```
5. **Add `auth` to the config** (next section).

The relay requests a client-credentials token for the Power Automate audience (`https://service.flow.microsoft.com/`), caches it until five minutes before it expires, and sends it as `Authorization: Bearer …`. If the workflow refuses a token, the relay fetches a new one and retries once. A wrong tenant, client ID or secret stops `teams test` and `teams relay` with `Teams app sign-in failed (HTTP 401, invalid_client)` and nothing else from Entra's answer. The secret and the tokens are never logged.

Entra client secrets expire: put a reminder in your calendar for the expiry you chose.

## 2. Configure

Add the following to `config/config.yaml`:

```yaml
notifications:
  teams:
    webhook_url_env: AUTOS_TEAMS_WEBHOOK_URL
    notify: [READY_FOR_HUMAN, BLOCKED, PAUSED, AUTOS_UP, AUTOS_DOWN]   # default
    include_commands: true                       # default
    # Only when the workflow requires sign-in (see "Tenants that require sign-in"):
    # auth:
    #   tenant_id: 00000000-0000-0000-0000-000000000000   # Directory (tenant) ID
    #   client_id: 00000000-0000-0000-0000-000000000000   # Application (client) ID
    #   client_secret_env: AUTOS_TEAMS_CLIENT_SECRET
    #   cloud: public                                     # or gcc, gcch, dod, china
```

`notify` can also include:
- `CANCELLED`, `PLANNED` (dry runs);
- `TIER_ESCALATED` (a role moved up a model tier);
- `PROVIDER_GATE` (new tickets are waiting because every provider of the SWE start tier is limited).

`AUTOS_UP` and `AUTOS_DOWN` (on by default) report Autos itself:
- **🟢 Autos is up:** the relay has connected to a controller process it has not announced before. The card shows when the controller started, whether auto poll is on, and how many jobs are running, paused and queued. Restarting only the relay does not post it again.
- **🔴 Autos is down:** the controller has stopped answering for 15 seconds, because it was stopped, crashed or the Mac went to sleep. It is posted once per outage.
- **🟢 Autos is back up:** the controller answers again after a down card. The card shows how long Autos was down.
- **⏹ Autos Teams notifications stopped:** the relay itself was stopped (Ctrl-C), so no more cards will come until it runs again.

These cards come from the relay, so the relay has to be running to post them. If the relay and the controller stop together, you get the "notifications stopped" card.

## 3. Run

With `.env` loaded and the controller running (`controller start`):

```sh
node apps/cli/bin/autos.mjs --config config/config.yaml teams test    # one "connected" card
node apps/cli/bin/autos.mjs --config config/config.yaml teams relay   # keeps running; Ctrl-C to stop
```

Keep the relay running next to the controller, for example in its own terminal.

## What a card contains

- **Title:** the issue key and the outcome, for example `✅ WTS-123 is ready for review` or `⛔ WTS-123 is blocked (CHECK_FAILED)`.
- **Facts:**
  - the job id, revision, feature branch, commit, base branch and repair rounds;
  - the SWE model tier (start → finish, with the number of escalations);
  - for a blocked job, Autos' own short reason;
  - for a pause, the role, the code and the time it resumes.
- **Next steps** (when `include_commands` is on): copyable commands such as `autos show WTS-123`, `autos revise WTS-123 --note "…"`, `autos close WTS-123 --merged` or `autos retry JOB_ID`.
- An **Open in Jira** button.

Cards never contain ticket text, operator notes, diffs, prompts, transcripts or provider output; only facts Autos itself authored. Text is stripped of control characters and markdown link syntax.

## Delivery and restarts

- **Starting point:** the relay follows the controller's event stream (`/v1/events/stream`). On its first start it begins at the current last event, so history is not replayed. Use `--from-start` to replay everything.
- **Resuming after a restart:** the relay records the last processed event in `data/teams-relay.json` (mode 0600) and resumes after it. Dropped connections reconnect with `Last-Event-ID`.
- **Failed deliveries:** each card is retried on network errors, HTTP 408, 429 and 5xx (with backoff, honouring `Retry-After` up to 60 s). Other 4xx answers fail at once, and redirects are refused. A card that still fails is logged as `teams_delivery_failed` and skipped, so one bad delivery cannot hold back later ones.
- **Logs:** stderr gets one JSON line per card (`teams_notified` with kind, issue key and event id). A `teams_delivery_failed` line for HTTP 401 or 403 carries a `hint` with the likely fix. The webhook URL, the operator token, the client secret and tokens are never logged.
