# vencord-message-collector

Initial implementation of the Discord-side component of a four-repository personal coordination system. This is a new, independent Git repository. It has no Pulse dependencies and does not modify either Pulse repository.

**Two capture paths:** explicitly started live Vencord sessions and user-selected local conversation files. Both use permissions, encrypted local buffering, and encrypted file handoff to a future `personal-coordination-mcp` receiver. The Vencord panel offers selected conversations or an **“Allow all conversations — at my own risk”** button. The standalone browser app supports file imports only.

**Live capture is unofficial and at your own risk.** Vencord acknowledges that client modifications violate Discord's [Terms](https://discord.com/terms). Participant permission does not provide platform approval. Live mode observes events already delivered to the signed-in client; it never reads account credentials, opens a user-token session, sends messages, scans message history, or requests backfill. See [policy findings and official alternatives](docs/POLICY.md).

## Start live capture in Vencord

Building this repository alone does not install the plugin. Follow [Vencord installation and usage](docs/VENCORD.md) to put `dist/messageCollector` into a Vencord source build, rebuild, and install that build. Then:

1. Enable **MessageCollector** in Vencord and open its settings. Create/unlock the encrypted buffer.
2. For one conversation, open it in Discord, click **Use current Discord conversation**, review the permission and allowed senders, attest your authority, and save. Confirm the unlocked session and press **Start live capture**.
3. For the entire account, click **Allow all conversations — at my own risk**, read the scope, check both authority and risk confirmations, then press **Start all conversations for one hour**. This includes all senders and newly joined supported conversations delivered to the current account. Export defaults off.
4. Keep Discord running. Capture continues while settings are closed/hidden, for up to one hour. **Stop live capture and lock**, logout, account changes, disable/reload, permission expiry, or storage/queue failures stop it. Unlocking never restarts capture automatically.
5. File import remains available in the same Vencord panel using a separate file permission. The standalone app has a separate browser buffer; there is no automatic bridge between them.

Only events delivered to this client can be captured. Unsubscribed channels and offline periods can have gaps, even with account-wide capture. No historical extraction, attachments, search service, or automatic MCP upload is implemented.

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
| Events | Imported snapshots and live create/update/delete events; edits replace buffered live text and observed deletes purge buffered copies; per-event provenance and timestamps |
| Permissions | Selected conversation/senders or explicitly acknowledged whole-account live scope; account binding, purpose, principal, at most 30 days, local-only default |
| Buffer | Whole-document AES-256-GCM, PBKDF2-SHA256, 600,000 iterations, fresh salt/IV, memory-only non-extractable keys, atomic IndexedDB updates |
| Bounds | 2 MiB / 1,000 messages per selected file; 5,000 buffered records; 8 MiB decrypted vault; 100 permission records; 500 recent audit records; pending live queue capped at 1,000 events / 2 MiB of serialized event text |
| Lifecycle | File mode locks on close/hide or five-minute inactivity; explicitly started live mode remains unlocked for at most one hour; expiry/revoke/disable/account change stop capture |
| Connector | Versioned encrypted handoff, reference decoder, per-event retry identifiers, recipient/scope/expiry checks; no network delivery |
| Audit | Encrypted bounded permission/import/live-start/create/update/delete/export/revoke/prune records; counts and permission IDs, no message text |

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

License: GPL-3.0-or-later. Publishing this source does not deploy a service or install the plugin.
