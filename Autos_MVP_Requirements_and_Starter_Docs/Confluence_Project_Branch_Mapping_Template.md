# Autos - Project Branch Mapping

Use this as the content of **one read-only Confluence page** that the local agent fetches by page ID. Add a row for each Jira project or (if necessary) each Jira project + repository combination. Do not put API tokens or secrets on this page.

| Project Key | Bitbucket Workspace | Repository Slug | Development Branch | Sandbox Branch | Enabled |
| --- | --- | --- | --- | --- | --- |
| WTS | REPLACE_WORKSPACE | REPLACE_REPOSITORY | wakanda | REPLACE_SBX_BRANCH | Yes |
| UWE | REPLACE_WORKSPACE | REPLACE_REPOSITORY | h1_phase2_dev | REPLACE_SBX_BRANCH | Yes |

**Rules for the MVP**

1. The development branch is used to create the new feature branch. The sandbox branch is informational only, not an automatic checkout target.
2. All fields except the sandbox branch must be non-empty and validated against an allowlist. A blank sandbox branch may be used if no sandbox exists.
3. If a project maps to multiple repositories, add an explicit project-component/repository selection rule in local config; otherwise reject ambiguous mappings. Do not guess.
4. The agent fetches `origin/<Development Branch>` and pins its latest SHA before creating a job branch.
5. If the Confluence page is missing, unreadable, malformed, or conflicts with the local repository allowlist, stop the job.
6. The agent never edits this Confluence page. You maintain it manually.
7. Set `branch_map_page_id` in the local configuration to the ID of this specific page; keep the page read-only to the agent.

**Branch naming:** `deep/{issueKey}` gives `deep/WTS-1234` or `deep/UWE-5678` by default. The full Jira key avoids collisions across projects. The numeric-only style can be configured later.
