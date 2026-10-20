# Verification report

Completed 2026-10-19 in the separate local `vencord-message-collector` Git repository. Pulse code was not opened for editing, imported, or changed. No remote repository, PR, deployment, Discord session, or external message was created.

## Results

| Check | Result |
|---|---|
| `npm run typecheck` | Passed: strict shared core/UI/standalone/test checks |
| `npm test` | **21 passed, 0 failed** |
| `npm run schema` | Generated five versioned JSON Schema files |
| `npm run build` | Passed: standalone web app and bundled private Vencord userplugin |
| `npm run test:browser` | **3 passed, 0 failed**, real headless Chromium |
| `npm run check:vencord -- <checkout>` | Passed: original plugin source checked against actual Vencord aliases/types |
| Vencord `pnpm build --standalone` with generated plugin present | Passed: desktop/main/preload/renderer artifacts |
| Vencord `pnpm testTsc` with generated plugin present | Passed |

Environment: Windows, Node.js 25.6.1, npm 11.9.0, Playwright 1.64.1 / Chromium 156.0.8078.4. Vencord reference commit: `32c90633ce6a95d7e56c95479efbb431bacf1eac`; dependencies installed from its frozen lockfile. The package declares Node 22+, but Node 22 itself was not exercised locally. A GitHub Actions workflow for Node 22 is included but has not run remotely.

## Coverage

- Locked-by-default behavior, disabled plugin behavior, explicit authorization and import/export confirmation.
- Server/thread/DM provenance invariants, exact account/channel/sender permissions, unknown-field rejection, malformed/oversized files, string IDs, selected package transcript conversion.
- Encrypted persistence across controller restart and browser reload; no private text/IDs/purpose/passphrase in stored envelope.
- Wrong password, tampered ciphertext/context/KDF, randomized encryption, non-extractable keys.
- Atomic failure on storage error, concurrent session conflict, real IndexedDB browser persistence and IndexedDB transaction CAS via fake-indexeddb.
- Deduplication, stable event IDs across handoff retries, recipient/scope/expiry checks, local-only export denial.
- Retention and revocation, 5,000-snapshot capacity, lock during import/unlock, partial update and content-free deletion schema.
- Host React late initialization and Vencord start/stop compatibility using a test harness; no message hooks are registered.
- Complete browser grant → safe text preview → import → reload → encrypted download → decoder → revoke → lock workflow; zero external requests observed during that workflow.
- Browser rejection of out-of-scope senders and clearing of an unimported preview after five minutes of inactivity.

Two initial browser test failures came from a locator that included option text and setting a file before permission-saving controls were re-enabled. The test harness now waits for enabled controls and uses the combobox role. The complete final browser suite passes. Source compatibility checks also led to deferring React lookup until panel render and aligning React type definitions with upstream; both are included in the final code.

## Not verified / remaining blockers

1. No logged-in Discord runtime test or Vencord injection was performed. Upstream build/source compatibility is verified, not platform approval or future client compatibility.
2. Continuous collection through a modified client is not implemented. See `POLICY.md` for the platform restriction and an official bot/interaction design. A bot service, permissions/intent review, consent handling and deployment remain future work.
3. Official export import was tested with synthetic documented-format fixtures, not the user's real package. Legacy CSV, changed layouts and numeric IDs need a lossless offline conversion adapter.
4. `personal-coordination-mcp` is not implemented here. The file protocol and decoder are ready for integration, but authenticated receiver ACLs, SQL/search, durable agent-access auditing and downstream revocation are not provided.
5. Encryption is browser-profile storage protection, not renderer isolation or verifiable secure deletion. Audit history is bounded, owner-controlled and not tamper-evident. See `SECURITY.md` for exact retention and trust boundaries.

## Concrete implementation

The repository contains source code, lockfile, license, synthetic example, five protocol schemas, CI configuration, core/browser tests and documentation. Generated plugin output is under `dist/messageCollector`; standalone output is under `dist/standalone`. Generated files and installed dependencies are excluded from Git and can be reproduced with `npm ci && npm run build`.
