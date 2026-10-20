# Verification report

Live-plus-import implementation verified 2026-10-19 in the separate `vencord-message-collector` Git repository. Pulse code was not opened for editing, imported, or changed. Verification used synthetic messages and a synthetic browser host, with no Discord session or client injection.

## Results

| Check | Result |
|---|---|
| `npm run typecheck` | Passed: strict shared core/UI/standalone/test checks |
| `npm test` | **49 passed, 0 failed** |
| `npm run schema` | Generated five versioned JSON Schema files |
| `npm run build` | Passed: standalone web app and bundled private Vencord userplugin |
| `npm run test:browser` | **8 passed, 0 failed**, real headless Chromium; file, timed-live and simplified always-on flows |
| `npm run check:vencord -- <checkout>` | Passed: original plugin source checked against actual Vencord aliases/types |
| Vencord `pnpm build --standalone` with generated plugin present | Passed: desktop/main/preload/renderer artifacts |
| Vencord `pnpm testTsc` with generated plugin present | Passed |

Environment: Windows, Node.js 25.6.1, npm 11.9.0, Playwright 1.64.1 / Chromium 156.0.8078.4. Vencord reference commit: `32c90633ce6a95d7e56c95479efbb431bacf1eac`; dependencies installed from its frozen lockfile. The package declares Node 22+, but Node 22 itself was not exercised locally. A GitHub Actions workflow for Node 22 is included; the results above describe local checks. Browser tests use isolated ports 4318/4319 so they do not stop the owner's app on 4317.

## Coverage

- Locked-by-default behavior, disabled plugin behavior, explicit authorization and import/export confirmation.
- Server/thread/DM provenance invariants, exact account/channel/sender permissions, unknown-field rejection, malformed/oversized files, string IDs, selected package transcript conversion.
- Encrypted persistence across controller restart and browser reload; no private text/IDs/purpose/passphrase in stored envelope.
- Wrong password, tampered ciphertext/context/KDF, randomized encryption, non-extractable keys.
- Atomic failure on storage error, concurrent session conflict, real IndexedDB browser persistence and IndexedDB transaction CAS via fake-indexeddb.
- Deduplication, stable event IDs across handoff retries, recipient/scope/expiry checks, local-only export denial.
- Retention and revocation, 5,000-snapshot capacity, lock during import/unlock, partial update and content-free deletion schema.
- Host React/store late initialization, disabled-by-default behavior and the exact Flux subscription set using a test harness.
- Complete browser grant → safe text preview → import → reload → encrypted download → decoder → revoke → lock workflow; zero external requests observed during that workflow.
- Browser rejection of out-of-scope senders and clearing of an unimported preview after five minutes of inactivity.

- Both sides of a DM; unselected scope/sender/optimistic/ephemeral filtering; Date/ISO timestamp normalization; attachment omission; duplicate creates; partial edits; latest live content replacement; known bulk deletions and cross-source purging; retained tombstones block stale reimports.
- Live permission/account/scope checks, membership changes, account switching, revocation, one-hour/permission expiry, queue overflow, storage failure, and serialized live/import writes.
- Account-wide risk confirmation, mutual exclusion with selected mode, newly observed DMs/group DMs/server channels/threads, all senders, actual per-event provenance, unsupported metadata skipping, account binding and scope-aware encrypted export.
- Browser confirmation controls, capture while the panel is hidden/unmounted, continued capture beyond the ordinary idle lock, file import during capture, automatic one-hour lock, account-wide confirmation, and no automatic restart after reload.
- The preceding one-hour/no-restart checks apply to optional timed mode. Always-on tests cover capture past 30 days with finite retention, automatic same-account restore, another-account denial, stop surviving restart, wrong passwords, unavailable OS encryption, malformed credentials, revoke, pending-unlock cancellation and double-click/stop races.
- Continuous buffer rollover preserves unrelated imported records and audits removal. The native helper is tested against a mock Electron encryption API; real Windows DPAPI inside Discord has not been exercised. Browser automatic-unlock tests use a clearly separated synthetic encryption adapter that is absent from production builds.
- Simplified UX: password entry alone does nothing; one accept button starts collection; advanced controls start collapsed; reload resumes without a second password; Stop stays off after reload. See [FLOW-REVIEW.md](FLOW-REVIEW.md).

The browser fixture is compiled only by a test server. It is absent from both production build entry points and never connects to Discord. Source compatibility checks use the actual upstream aliases/types, while the generated plugin is also included in the upstream build and type check.

## Not verified / remaining blockers

1. No logged-in Discord runtime test or Vencord injection was performed. Upstream build/source compatibility (including native helper) is verified, not platform approval, real OS-protection behavior in Discord, or future client compatibility. The native helper requires a full Discord restart after rebuilding.
2. Live capture is implemented but unofficial, not platform-approved, and not a completeness guarantee. It is bounded to explicit sessions and events delivered to the client. No history, offline backfill, token access, attachments, voice recording, bot deployment, or independent consent service is implemented. High-volume account-wide capture can exhaust its queue/vault and stop.
3. Official export import was tested with synthetic documented-format fixtures, not the user's real package. Legacy CSV, changed layouts and numeric IDs need a lossless offline conversion adapter.
4. `personal-coordination-mcp` is not implemented here. The file protocol and decoder are ready for integration, but authenticated receiver ACLs, SQL/search, durable agent-access auditing and downstream revocation are not provided.
5. Encryption is browser-profile storage protection, not renderer isolation or verifiable secure deletion. Audit history is bounded, owner-controlled and not tamper-evident. See `SECURITY.md` for exact retention and trust boundaries.

## Concrete implementation

The repository contains source code, lockfile, license, synthetic example, five protocol schemas, CI configuration, core/browser tests and documentation. Generated plugin output is under `dist/messageCollector`; standalone output is under `dist/standalone`. Generated files and installed dependencies are excluded from Git and can be reproduced with `npm ci && npm run build`.
