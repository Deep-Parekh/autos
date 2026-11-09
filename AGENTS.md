# Autos development instructions

Build the system described in docs/implementation-plan.md and docs/implementation-tasks.md. Preserve the original starter documents. Do not present planned commands, fake tests, or adapters as a working autonomous service.

## Ownership and delegation

The primary agent owns root manifests, lockfiles, configuration, packages/contracts, shared docs, integration tests, and apps/controller/src/runtime.ts. Use GPT-6 Luna with high reasoning for authorized implementation workers. Task A owns packages/atlassian and tests/atlassian; B owns packages/cli-adapters and tests/cli-adapters; C owns packages/git-runner and tests/git-runner. Task D owns packages/workflow and tests/workflow. Task E owns apps/cli, apps/controller (except runtime.ts), tests/interfaces, docs/openapi.yaml, docs/cli.md, and docs/api-publishing.md. Task F owns packages/runner, docker, docker-compose.yml, tests/fixtures, and tests/e2e. Do not edit another owner's files. Request shared-contract or dependency changes from the primary agent. Do not spawn more workers unless authorized for that phase.

## Implementation rules

- Use TypeScript strict mode and exported @autos/contracts types. Use Zod schemas at trust boundaries. Errors and logs must not contain tokens, credential-bearing URLs, or raw upstream response bodies.
- Jira and Confluence clients expose reads only. No PR creation, merge, rebase, force-push, or deployment operations. Push is disabled by default and belongs to trusted Git code.
- Invoke processes with argument arrays, never interpolated shell commands. Roles use fresh sessions. Provider narrative is not deterministic test evidence.
- Agent permission enforcement belongs to the trusted runner. A direct subprocess adapter is not an isolation boundary and must not be wired to production job execution before task F.
- Only SWE may edit ticket source; QA/reviewer get source-read access and separate output locations. Infrastructure credentials stay outside agent workspaces.
- READY_FOR_HUMAN requires passing checks, QA, and review tied to the same final candidate. NOT_RUN, stale evidence, malformed output, or a timeout blocks finalization.
- Tests use fake services/processes or disposable local repositories. Do not run live coding providers, touch company repositories, authenticate accounts, or mutate external systems during this implementation phase.

## Verification and handoff

Run focused tests with npm test -- tests/<module>/<file>.test.ts, then npm run typecheck. The primary agent runs npm run check after integration. Report changed files, executed checks, missing prerequisites, and remaining limitations. Workers do not commit or push. The primary agent handles integration commits if needed.
