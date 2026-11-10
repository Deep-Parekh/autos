# Autos Teams bot

The Teams bot lets approved Teams users start and inspect Autos jobs. It runs beside the controller and accepts Bot Framework activities on loopback. Teams needs an HTTPS messaging endpoint, so expose only the bot's local port through a tunnel or reverse proxy.

## Set up the Azure bot

1. In Azure, create an Azure Bot configured for a **single tenant**, using the existing Entra app or a new app registration. Enable the **Microsoft Teams** channel.
2. Create a client secret for the Entra app. Store its value in the environment variable named by `teams_bot.client_secret_env`; do not put the secret in the Autos config.
3. Set the Azure Bot messaging endpoint to `https://<tunnel-host>/api/messages`.
4. Run a tunnel to `127.0.0.1:3978`. Microsoft Dev Tunnels can provide anonymous access to that one port, or use Cloudflare Tunnel. Keep the local listener on loopback and expose no other port.
5. Add the bot settings to the Autos config. `allowed_users` contains Entra user Object IDs (Entra admin center → Users → your user → Object ID):

   ```yaml
   teams_bot:
     app_id: 11111111-2222-4333-8444-555555555555
     tenant_id: 22222222-3333-4444-8555-666666666666
     client_secret_env: AUTOS_TEAMS_BOT_SECRET
     listen_host: 127.0.0.1
     port: 3978
     allowed_users:
       - 33333333-4444-4555-8666-777777777777
   ```

6. Build the Teams app package and upload it in Teams: **Apps → Manage your apps → Upload a custom app**. The config must contain a valid `teams_bot` section and the configured app ID must match the Azure Bot's Microsoft App ID.

   ```sh
   node --conditions=development --import tsx scripts/teams-app-package.ts --config PATH
   ```

   The package is written to `artifacts/teams-app/autos-teams-app.zip`. To choose another output directory, add `--out DIRECTORY`.

7. Start the controller, then start the bot next to it in its own terminal, with `.env` loaded:

   ```sh
   node apps/cli/bin/autos.mjs teams bot
   ```

   On start the bot fetches one Bot Framework token, so a wrong app ID, tenant or secret fails at once with `Teams app sign-in failed`. It then prints `Autos Teams bot listening on 127.0.0.1:3978`. Stderr gets one JSON line per activity (`teams_bot_command`, `teams_bot_replied`, `teams_bot_refused`, `teams_bot_auth_rejected`); tokens, secrets and note text are never logged.

8. In Teams, add the app to your team (or open it in a personal chat) and type `help`. In a channel, mention it first: `@Autos run https://…/browse/KEY only change the billing module`.

Notifications keep coming from `autos teams relay` (see [teams.md](teams.md)). Run both if you want notifications and commands.

## Commands

- `help` shows the available commands.
- `run` opens a form. `run KEY [dry run] [notes…]` starts a job directly.
- `status` shows controller health and active jobs.
- `show KEY` displays the latest job for a Jira issue.
- `note KEY [swe:|qa:|reviewer:|all:] text [hold]` adds instructions.
- `revise KEY [roles swe,qa] text` revises an eligible job.
- `retry JOB_ID` retries a blocked or cancelled job.
- `release KEY` releases a held job.
- `close KEY merged|abandoned` and `cancel JOB_ID` ask for confirmation before acting.

The bot also provides job cards with actions appropriate to the job state. The controller remains the authority for what actions are allowed.

## Who did what

Every controller call the bot makes is labelled `teams-<Entra object ID>` (the `X-Autos-Operator` audit label), so `controller start` audit lines and note authors show which Teams user acted.

## Security

The bot accepts only authenticated Bot Framework activities and checks each sender against `teams_bot.allowed_users` and the configured tenant. Its HTTP listener binds to `127.0.0.1` (or `::1`) and accepts only the activity endpoint plus its health check. Keep the tunnel scoped to that port. The bot calls the loopback controller with the operator token; keep that token and the Entra client secret in environment variables. Jira and Confluence access remains read-only, and the bot cannot merge or deploy.

Details:
- **Inbound requests:** each one must carry a Bot Framework token. The bot checks that it is RS256-signed by Microsoft's published keys, that its issuer is Bot Framework or your tenant, that its audience is `app_id`, and that its service URL claim equals the activity's. A plain app token for the bot's audience, which any app in your tenant can obtain, is rejected because it has no service URL claim.
- **Replies:** they go only to Teams service hosts (`smba.trafficmanager.net`, `*.botframework.com`, `*.teams.microsoft.com`).
- **Confirmations:** close and cancel run only after a click on the confirmation card. A typed `close` or `cancel` only shows that card.
- **Input:** Jira links are reduced to the issue key and checked against `jira.allowed_projects`. Notes are limited to `teams_bot.max_note_chars` and are delivered to the agents as operator notes, exactly like `autos note`.
