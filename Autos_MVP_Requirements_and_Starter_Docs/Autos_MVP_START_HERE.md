# Autos | Build the first working prototype

This bundle contains **planning and configuration examples, not executable Autos code**. The MVP is intentionally simpler than the eventual team service.

## Intended outcome

Select one existing bug from a personal Jira saved filter, read the Confluence project branch-map, optionally inspect similar resolved Jira/Bitbucket fixes, obey repository `AGENTS.md`, implement the fix through one of three CLI providers, run deterministic tests and independent QA/reviewer agents, repair findings within a capped loop, and commit `deep/<FULL_JIRA_KEY>` from the correct development branch. Optionally push only that feature branch. Human manually inspects, rebases, creates a PR if desired, and merges.

**Read-only external sources:** Jira and Confluence. **MVP Git write:** an isolated feature branch only. No automated Jira mutation, Confluence draft/page creation, PR creation, merge, rebase, force-push, or deployment.

## Suggested first coding sequence

1. Create the `autos` TypeScript monorepo, Docker Compose controller, persistent SQLite state and synthetic fixture repository.
2. Implement `autos init` with typed config validation, and `autos doctor` for credentials, network, binaries and branch mapping.
3. Build the three CLI provider adapters with subprocess timeouts and normalized status/results; include `autos providers test --all`.
4. Implement Jira private saved-filter intake using read endpoints and Confluence branch-map page retrieval by ID.
5. Implement a Git runner that creates a fresh isolated workspace from the remote development branch SHA. Do not reuse the developer's current checkout.
6. Implement the SWE stage and a deterministic Java/Maven test profile against the fixture bug.
7. Add independent QA and reviewer sessions, two bounded repair cycles, and BLOCKED/READY_FOR_HUMAN states.
8. Implement Git commit, optional feature-only push, and local implementation/test/review/manifest artifacts.
9. Define local controller HTTP routes and generate `docs/openapi.yaml` from code schemas. Validate against the starter specification included here.
10. Test in dry-run against one approved real Jira issue before enabling any Git push. Confirm no Jira/Confluence write calls ever occur.

## CLI design (commands to IMPLEMENT, not installed yet)

```bash
autos init
autos doctor
autos providers test --all
autos run WTS-1234 --dry-run
autos run WTS-1234
autos queue list
autos docs validate
autos docs preview
```

## Files in this bundle

- `On_Prem_AI_SWE_Agent_Requirements_and_Implementation_Plan.docx` - detailed system requirements and phased implementation plan.
- `AI_SWE_Agent_Pre_Server_Build_Checklist.md` - ordered engineering work items and acceptance criteria.
- `On_Prem_AI_Agent_IT_Server_Request.txt` - infrastructure request for later.
- `AI_SWE_Agent_MVP_Config_Example.yaml` - first-release config skeleton; replace placeholders, store secrets separately.
- `Confluence_Project_Branch_Mapping_Template.md` - page template to create manually in Confluence.
- `Autos_OpenAPI_3_1_Starter.yaml` - **proposed, not live**, HTTP controller interface documentation.
- `Autos_API_Documentation_and_Publishing_Guide.md` - code-first OpenAPI generation, validation, example docs and eventual-publication checklist.

## OpenAPI documentation policy

The CLI itself has a command reference and `autos --help`; **OpenAPI documents the optional HTTP controller**. Export the contract from validated Fastify route schemas and fail CI on spec drift. Bind the API to localhost/VPN, redact all credentials/organization data and do not publish an internet-facing API in the MVP.
