# Autos | API documentation and eventual publication guide

**Stage:** MVP documentation blueprint. The OpenAPI file is a proposed contract, not an API implementation. The local controller and `autos` CLI must be built and verified before any documented HTTP endpoint can be called.

## What is documented from day one

- **Product CLI:** `autos init`, `autos doctor`, `autos providers test --all`, `autos run ISSUE-123 --dry-run`, `autos run ISSUE-123`, `autos queue list`, `autos docs validate`, and `autos docs preview`. These are *planned commands to implement*; the CLI itself is documented with `autos --help` plus a command-reference Markdown guide, **not** OpenAPI.
- **Local controller HTTP API:** defined by `docs/openapi.yaml` (starter provided as `Autos_OpenAPI_3_1_Starter.yaml`). The API is intended to let a future dashboard or installation tool use the same controller as the CLI. In MVP the controller listens on `127.0.0.1:8787` or a VPN-only interface and requires operator authentication except for a minimal health endpoint.
- **Docs as code:** all endpoint names, request bodies, responses, authentication, error codes, operation IDs and examples are versioned and reviewed in Git.

## Source-of-truth strategy

Use **code-first route schemas in TypeScript/Fastify** and generate OpenAPI 3.1 using `@fastify/swagger`. The initial starter YAML is the target design. As soon as HTTP routes exist, export the spec from the running controller and make generated OpenAPI the source of truth; remove duplicated handwritten definitions and reject out-of-sync docs in CI. Alternatively, spec-first is acceptable if its validators generate working contracts; choose only one authoritative source.

Recommended repository layout:

```text
autos/
  apps/controller/src/routes/
  apps/cli/src/                      # autos executable and --help text
  docs/openapi.yaml                  # exported OpenAPI 3.1 contract
  docs/api-publishing.md             # this guide
  docs/architecture.md
  docs/configuration.md
  docs/security.md
  docs/cli.md
  docs/examples/                     # synthetic, public-safe examples
  README.md
  CHANGELOG.md
```

## API coverage for first prototype

| Operation | Purpose |
| --- | --- |
| `GET /health` | Minimal process health |
| `GET /v1/providers` | Which of Claude/Codex/Cursor adapters are installed and ready |
| `GET /v1/projects` | Redacted, read-only project mapping summary |
| `GET /v1/queue` | Jira saved-filter intake and local statuses |
| `POST /v1/jobs` | Run one issue; `dry_run` defaults to `true` |
| `GET /v1/jobs` | Local run history |
| `GET /v1/jobs/{jobId}` | Job status and base/feature Git metadata |
| `GET /v1/jobs/{jobId}/artifacts` | Sanitized manifest of generated artifacts |
| `POST /v1/jobs/{jobId}/cancel` | Ask an active job to stop safely |

**No endpoint** for Jira writes, Confluence writes, PR approval/merge, deployment, rebase, force-push or arbitrary filesystem access.

## Documentation acceptance criteria

1. Every API route has a stable `operationId`, request/response JSON Schema, examples and matching TypeScript validation.
2. Sensitive values (auth tokens, provider account paths, internal stack traces and customer data) cannot appear in API responses or exported examples.
3. API errors include `{code, message, request_id, details?}`. Validate 400, 401, 403, 404, 409, 422 and 429 responses.
4. `autos docs validate` lints the exported OpenAPI and confirms it matches implemented routes and models.
5. `autos docs preview` serves a **local-only** Swagger UI or Scalar reference. The docs endpoint must not make controller operations publicly accessible.
6. Contract tests compare actual test HTTP requests/responses against the OpenAPI shapes; fail the build on drift.
7. Document one real dry-run workflow using synthetic ticket and repository names. Include the planned container setup and common failures in README and docs/cli.md.

## Later publication workflow

1. Pick public documentation scope: CLI usage, local API reference, installation, configuration, security model, troubleshooting and examples. Avoid claims that Autos is a hosted service unless a secured multi-user deployment exists.
2. Create tagged releases with semantic versioning and a matching `info.version` in the OpenAPI document.
3. Export the API reference as static docs (e.g. Swagger UI, Scalar or Redoc) from the versioned OpenAPI artifact. Keep the executable's `--help` output and Markdown CLI docs synchronized.
4. Replace ALL internal Atlassian URLs, customer names, project/branch names, personal identities, tokens and private repo artifacts in published examples with synthetic values.
5. Validate security: never publish live endpoints, credentials or private infrastructure details; add authentication/rate-limiting strategy before any external HTTP access.
6. Complete legal and organizational review of company IP, licensing, third-party CLI terms, Atlassian use, support obligations, vulnerability disclosure and data handling.
7. Publish a versioned changelog, install matrix, OpenAPI reference, known limitations and support/contact policy. Distinguish 'preview', 'beta' and 'stable' capabilities accurately.

**References:**

- OpenAPI specification: https://spec.openapis.org/oas/v3.1
- Fastify OpenAPI generation: https://github.com/fastify/fastify-swagger
- OpenAPI Initiative: https://www.openapis.org/
