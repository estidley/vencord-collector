# Verification: expanded capture and reader safeguards

Verified locally on 2026-10-22 using synthetic fixtures.

- Collector: 75 unit/integration tests passed; typecheck and production build passed.
- Receiver: 47 unit/integration tests passed; TypeScript build passed.
- Browser: 11 Playwright scenarios passed, including personal-nickname preference and persistence.
- Prepared upstream Vencord standalone build and full TypeScript check passed.
- Collector source checked against the pinned Vencord checkout successfully.
- Cross-repository check passed: actual Collector -> encrypted HTTP /v1/ingest -> encrypted SQLite -> SDK MCP reads; eight message detail categories and nine activity observation types.
- Adversarial tests covered hostile names/roles/filenames/embeds, action-tool requests, dangerous URL schemes, restricted metadata search, cursor/ACL changes, replay, revocation, unknown fields and credential separation.

Browser test ports were configured to 14318/14319 because 4318 was occupied; the existing listener was not stopped.

These checks do not constitute a logged-in Discord runtime test or a model-level guarantee against prompt injection. See RED-TEAM.md in personal-coordination-mcp for residual host/tool isolation requirements. Existing message credentials keep their prior scopes; new activity scopes require owner configuration. No Pulse files were changed.

Reproduce cross-repository check after building the receiver:

    node --import tsx scripts/check-receiver.ts <path-to-personal-coordination-mcp>

This runner lives in vencord-collector and uses only temporary in-memory synthetic data. Model evaluation prompts in the receiver docs are designed but have not been run against an LLM.
