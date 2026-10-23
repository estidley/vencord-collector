# Vencord Collector

**2026-10-22 update:** [People-first capture and read-only MCP integration](docs/EXPANDED-CAPTURE.md) adds personal nickname preference, scoped message details and activity sync. That guide supersedes older activity-local-only limitations below.

Initial implementation of the Discord-side component of a four-repository personal coordination system. This is a new, independent Git repository. It has no Pulse dependencies and does not modify either Pulse repository.

**Live capture and imports:** always-on Vencord collection after one password and one acceptance, plus user-selected local conversation files. Both use permissions, encrypted buffering, and explicit encrypted file handoff to a future `personal-coordination-mcp` receiver. Selected conversations and timed sessions remain under Advanced. The standalone browser app supports file imports only.

**Live capture is unofficial and at your own risk.** Vencord acknowledges that client modifications violate Discord's [Terms](https://discord.com/terms). Participant permission does not provide platform approval. Live mode observes events already delivered to the signed-in client; it never reads account credentials, opens a user-token session, sends messages, automatically traverses history, or requests backfill. See [policy findings and official alternatives](docs/POLICY.md).

## Start live capture in Vencord

Building this repository alone does not install the plugin. Follow [Vencord installation and usage](docs/VENCORD.md) to put `dist/messageCollector` into a Vencord source build, rebuild, and install that build. Then:

1. Enable **MessageCollector** in Vencord on Windows Desktop and open its settings.
2. Enter a unique buffer password of at least 16 characters. Read the scope and press **Accept at my own risk and start collecting** once.
3. Collection starts for all supported conversations delivered to this account and continues with settings closed or hidden. There is no one-hour limit. Discord restarts automatically unlock and resume for this account without another prompt. Windows protects the remembered password; no plaintext password is stored.
4. **Stop collecting and forget password** stops immediately, removes automatic unlock, and stays off after restart. Logout/account changes pause capture; the saved permission applies only to the originally accepted account. Plugin disable also removes automatic unlock.
5. File imports, exports, individual permissions and optional one-hour sessions remain under **Advanced**. The standalone app supports files only and has a separate browser buffer.

Always-on permission lasts until revoked. Messages are not retained forever: the default is seven days, with at most 5,000 records / 8 MiB in the vault. Continuous mode rolls out its oldest entries when full, preserving unrelated imports. Storage errors, queue overflow, or a vault filled by other permissions still stop capture with an error. There is no claim of lossless collection or an unlimited archive. See [security boundaries](docs/SECURITY.md) and [adversarial flow review](docs/FLOW-REVIEW.md).

Only events delivered to this client can be captured. Unsubscribed channels and offline periods can have gaps, even with account-wide capture. A separate review-and-confirm button can save the selected conversation's already-loaded messages. Opt-in scheduled-event, presence and voice observations are also available. Optional **receiver sync** sends what always-on collects to your own `personal-coordination-mcp` on `127.0.0.1` (see below). No automatic historical extraction, attachment downloads, notification delivery, or delivery to any other host is implemented. See [data collection and history limits](docs/DISCORD-DATA.md).

## Sync to personal-coordination-mcp (optional)

This makes Discord searchable by your own agents the way an Outlook or Gmail MCP makes mail searchable: the collector keeps your local receiver's mailbox current, and agents read it on demand through the receiver's **read-only** MCP tools. Synced messages are data, never commands; nothing in the pipeline acts on message text.

1. In `personal-coordination-mcp`, issue an `ingest`+`checkpoint` credential (for example `collector-home`) using its `examples/collector-sync-policy.json`, and start the receiver (default `127.0.0.1:4320`).
2. In the plugin's always-on setup, tick **Also sync everything collected to my personal-coordination-mcp receiver**, keep or change the importer ID and port, and paste that credential's token. Setup checks the token with the receiver before anything is armed.
3. New captures, edits and deletes arrive within seconds while Discord is open. The settings panel shows pending/delivered counts and the last sync; **Sync now** forces a pass.

Sync uses its own export-enabled account-wide permission, so an existing always-on setup must be stopped and accepted again with sync ticked. Records collected under the old local-only permission are not migrated. Stopping collection removes the sync settings; it does not delete what the receiver already holds — revoke the grant there with its owner credential. Only `127.0.0.1` is ever contacted. See [CONNECTOR.md](docs/CONNECTOR.md#receiver-sync) for the delivery rules and failure handling.

## Events, presence and loaded messages

Expand **Scheduled events, presence and voice** after starting collection. Select servers and specific people, confirm permission, and save. Existing permissions keep these categories off until accepted. Presence means observed status, not login or server viewing; voice duration is only the observed interval. Scheduled-event snapshots retain recurrence rules but do not resolve future occurrences or exceptions.

To save a loaded conversation, open its authorized section in Discord, then use **Save messages already loaded in Discord → Review loaded conversation → Save reviewed loaded messages**. This is a bounded manual snapshot, not a full-history crawler. [Detailed instructions, supported data and authorized alternatives](docs/DISCORD-DATA.md).

The repository is now `vencord-collector`. The installed plugin ID `MessageCollector`, generated folder and encrypted database names remain stable for compatibility with existing installations.

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
| Events | Imported or explicitly selected cached snapshots and live create/update/delete events; edits replace buffered live text and observed deletes purge buffered copies; per-event provenance and timestamps |
| Permissions | Selected or whole-account scope; ongoing live grants last until revoked; ordinary grants expire within 30 days; account binding and local-only default |
| Buffer | Whole-document AES-256-GCM, PBKDF2-SHA256, 600,000 iterations, fresh salt/IV, memory-only non-extractable keys, atomic IndexedDB updates |
| Bounds | 2 MiB / 1,000 messages per selected file or cached selection; 5,000 message records and 2,000 activity observations; 8 MiB decrypted vault; 100 permission records; 500 recent audit records; pending live queue capped at 1,000 events / 2 MiB of serialized event text |
| Lifecycle | Always-on resumes the accepted account after restart using Windows-protected credentials; Stop removes auto-start; optional timed sessions and file-mode idle locking remain |
| Connector | Versioned encrypted handoff, reference decoder, per-event retry identifiers, recipient/scope/expiry checks; manual file or opt-in loopback sync |
| Receiver sync | Opt-in at always-on setup; own export-enabled account grant; token + generated transfer key OS-protected and used only by the native helper; records marked delivered only on a committed receipt; edits/deletes re-sent; backoff; refused events isolated and set aside; full buffer drops delivered records first |
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
