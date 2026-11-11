# Autos

Autos will process bugs selected through a private Jira saved filter, resolve the correct Bitbucket repository and development branch from Confluence, and run coding, test, QA, and review stages in an isolated workspace. A successful run produces a committed `deep/<ISSUE_KEY>` feature branch and evidence for human review.

The foundation and all six workstreams (Atlassian reads, CLI adapters, Git runner, durable workflow/queue, operator CLI/API, fixtures and Docker runner) are implemented and tested with fakes. The first scenario, a synthetic end-to-end ticket run, works locally:

```sh
npm run scenario:synthetic            # add -- --keep to inspect the workspace and evidence
```

It starts the real controller on loopback and reads a fake private Jira filter and Confluence branch map through the real Atlassian client. Each ticket is pinned to the `develop` SHA of a disposable local remote. Fake claude/codex/cursor processes run the SWE, QA and reviewer roles through the real adapters, and real `javac`/`java` checks run before the commit to `deep/SAMPLE-123`. A filter poll then drains the remaining tickets one at a time: one ticket needs a reviewer-requested repair round, and two block without stopping the queue. No external system is contacted and nothing is pushed.

Limits: the scenario uses a **test-only local runner that is not an isolation boundary**, and fake providers are not provider certification. Real ticket execution requires Docker (the host supervisor and the worker/checks images in `docker/`), approved provider logins, and the pilot Jira/Confluence/Bitbucket configuration. None of these has been exercised yet.

- [Server setup](docs/server-setup.md) — Ubuntu deployment: Compose controller, systemd supervisor, credentials, safe first run.
- [Local pilot on macOS](docs/local-pilot.md) — the same flow on a Mac with Docker Desktop.
- [Read-only Jira and Confluence tools for agents](docs/knowledge.md) — optional knowledge tools: setup, allow-list, limits and risks.
- [Environment requirements](docs/environment-requirements.md) — what must be installed on the host and in the Docker images on a new machine.
- [Architecture and design decisions](docs/architecture/architecture-and-design-decisions.md) — how Autos is built, the tools it uses, and why each choice was made over the alternatives.
- [Architecture diagram](docs/architecture/autos-server-architecture.html) — components, trust boundaries and the life of one ticket.
- [Implementation plan](docs/implementation-plan.md) — scope, architecture, delivery order, and decisions needed before coding.
- [Independent implementation tasks](docs/implementation-tasks.md) — six GPT-6 Luna workstreams, ownership, dependencies, and acceptance criteria.
- [Foundation usage](docs/foundation.md) — build/test commands, canonical configuration, contracts, and execution boundaries.
- [First implementation wave](docs/wave-one.md) — delivered modules, verification, review decisions, and remaining work.
- [Original starter documents](Autos_MVP_Requirements_and_Starter_Docs/Autos_MVP_START_HERE.md) — the proposal and configuration/API examples supplied for the project.

The MVP processes one ticket at a time. Jira and Confluence remain read-only. Feature-branch pushing is configurable; PR creation, merging, rebasing, and deployment remain manual.

To check the current implementation, run `npm ci --ignore-scripts` followed by `npm run check`. After building, `node_modules/.bin/autos --help` displays the foundation preview.
