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

## 2. Configure

Add the following to `config/config.yaml`:

```yaml
notifications:
  teams:
    webhook_url_env: AUTOS_TEAMS_WEBHOOK_URL
    notify: [READY_FOR_HUMAN, BLOCKED, PAUSED]   # default
    include_commands: true                       # default
```

`notify` can also include:
- `CANCELLED`, `PLANNED` (dry runs);
- `TIER_ESCALATED` (a role moved up a model tier);
- `PROVIDER_GATE` (new tickets are waiting because every provider of the SWE start tier is limited).

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
- **Logs:** stderr gets one JSON line per card (`teams_notified` with kind, issue key and event id). The webhook URL and the operator token are never logged.
