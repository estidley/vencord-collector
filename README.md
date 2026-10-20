# vencord-message-collector

Initial implementation of the Discord-side component of a four-repository personal coordination system. This is a new, independent Git repository. It has no Pulse dependencies and does not modify either Pulse repository.

**Working subset:** user-selected local conversation files → explicit conversation permissions and preview → encrypted local buffer → encrypted file for a future `personal-coordination-mcp` receiver. A standalone offline app is the primary entry point. An optional Vencord userplugin exposes the same panel.

**No continuous Discord capture is implemented.** Discord's [Terms](https://discord.com/terms) restrict unauthorized client modifications and scraping. The Vencord panel is an experimental compatibility artifact, not an assertion of platform approval. Consent between participants does not override Discord's rules. See [policy findings and the supported alternative routes](docs/POLICY.md).

## Run locally

Requires Node.js 22 or later and npm.

```sh
npm ci
npm run check
npm start
```

Open `http://127.0.0.1:4317`. The server only serves the built app on loopback; it has no message-ingestion, credentials, or upload endpoint. All imported data stays in that browser profile's IndexedDB. Use the same origin and browser profile on subsequent visits.

1. Create a buffer with a unique passphrase of at least 16 characters. No recovery is available.
2. Edit the permission example with the correct account, conversation, sender IDs, purpose, and expiry; affirm authority. Permissions default to local storage only. To permit handoff, explicitly set `allowExport` to `true` and choose `principalId` for the future receiver.
3. Choose a local normalized JSON file or a selected official package `messages.json`, review its count/senders/sample, then confirm import. The UI labels the confirmation as applying to all messages in the file.
4. To export, select the permission, supply a separate transfer passphrase, and explicitly confirm the named recipient. Deliver the encrypted `.pcmc.json` file and passphrase separately.
5. Lock the panel when finished. Revocation erases that permission's buffered messages. Existing downloaded copies must be deleted separately at their recipient.

The fixture at [examples/manual-conversation.json](examples/manual-conversation.json) uses synthetic data only; it matches the default permission's example IDs. Replace those IDs for real use. Official package import instructions and limitations are in [IMPORTS.md](docs/IMPORTS.md).

## What is implemented

| Area | Behavior |
|---|---|
| Provenance | Server/channel/thread parent/DM/group DM IDs, optional names and participant IDs; unknown metadata stays null; user-supplied provenance is labeled |
| Events | Imported snapshots with sender/message IDs and source/observation/expiry times; versioned create/update/delete schemas reserved for an authorized bot |
| Permissions | Exact account and conversation, sender allowlist, stated purpose, principal, at most 30 days, local-only default, explicit import/export confirmations |
| Buffer | Whole-document AES-256-GCM, PBKDF2-SHA256, 600,000 iterations, fresh salt/IV, memory-only non-extractable keys, atomic IndexedDB updates |
| Bounds | 2 MiB / 1,000 messages per selected file; 5,000 buffered snapshots; 8 MiB decrypted vault; 100 permission records; 500 recent audit records |
| Lifecycle | Lock on close/hide/disable and five-minute inactivity; prune expired data when unlocked or used; revoke removes local content |
| Connector | Versioned encrypted handoff, reference decoder, per-event retry identifiers, recipient/scope/expiry checks; no network delivery |
| Audit | Encrypted bounded records of permission/import/export/revoke/prune actions, with counts and permission IDs, no message text |

## Repository map

- `src/core/`: validation, import adapter, cryptography, permissions, buffering, connector decoder.
- `src/ui/`: shared React panel; `src/plugin/`: Vencord lifecycle wrapper.
- `protocol/`: generated JSON Schemas. Runtime validation additionally enforces cross-field invariants.
- `docs/`: policy research, security model, connector contract, Vencord installation/build notes, verification results.
- `tests/`: core, encryption, permissions, persistence and browser flow tests.
- `dist/standalone/` and `dist/messageCollector/`: generated runnable builds (`npm run build`).

The future MCP repository owns authenticated agent access, SQL persistence, search, revocations of exported data, and durable query auditing. Neither Pulse Android nor its server belongs in this repository. See [CONNECTOR.md](docs/CONNECTOR.md).

## Development

```sh
npm run typecheck
npm test
npm run schema
npm run build
npx playwright install chromium
npm run test:browser
```

The lockfile pins dependencies. No Discord login, bot token, user token, or real messages are needed for tests. [Verification report](docs/VERIFICATION.md) distinguishes tests from live integration limitations.

License: GPL-3.0-or-later. No remote repository or public deployment is created by this implementation.
