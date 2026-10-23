# personal-coordination-mcp connector v1

**2026-10-22 update:** [People-first capture and read-only MCP integration](EXPANDED-CAPTURE.md) adds personal nickname preference, scoped message details and activity sync. That guide supersedes older activity-local-only limitations below.

Implemented transports: **explicit encrypted file handoff**, and opt-in **receiver sync** of the always-on permission to `personal-coordination-mcp` on `127.0.0.1` ([below](#receiver-sync)). No web server inside the collector receives messages, and no host other than loopback is ever contacted. Both use the same versioned batch; the receiver does not depend on Vencord or Pulse.

## Envelope and plaintext

`protocol/envelope.schema.json` describes the outer envelope: version 1, context `coordination-batch/v1`, PBKDF2-SHA256 at exactly 600,000 iterations, AES-256-GCM, a random 16-byte salt, random 12-byte IV, and ciphertext with a 128-bit authentication tag. Salt/IV/ciphertext use standard padded Base64. UTF-8 JSON is the plaintext. The transfer key is derived from a separately supplied passphrase; no key or message metadata is stored in the outer envelope.

Additional authenticated data is the UTF-8 string:

```
coordination-batch/v1|1|PBKDF2-SHA256|600000|AES-256-GCM|<base64-salt>
```

The plaintext has protocol `personal-coordination/ingest-file`, version 1, a new UUID batch ID, audience `personal-coordination-mcp`, explicit principal ID, creation and expiry timestamps, one permission record, and its snapshot or live events. See `protocol/batch.schema.json`. `src/core/connector.ts` validates recipient, expiry, source/account/scope/sender constraints, and duplicate event IDs within a batch.

Permission `scope` defaults to `conversation` for older files. In that scope, provenance and sender allowlist must be present. `scope: account` is permitted only for `source: vencord-live`; grant provenance is null and the sender list is empty, explicitly meaning all supported conversations and senders on that account. Each event still requires full actual provenance. Receivers must explicitly authorize account scope; never silently translate it into narrower consent. Existing decoders need the updated schema/logic before accepting the new source/scope. No older receiver is assumed to support them.

**The passphrase authenticates ciphertext integrity, not a person's identity or legal authority.** A caller with the passphrase can create another valid envelope. The future receiver must authenticate the importing user and independently authorize the principal and scope. Do not turn a producer-supplied grant into an agent access token.

Continuous live permissions add `continuous: true` and `expiresAt: null`; only `vencord-live` may use that combination. Older grants default to `continuous: false`. Events and batches always retain finite expiry timestamps. Receivers must explicitly recognize and authorize ongoing permissions; null grant expiry does not waive message retention. OS-protected auto-unlock credentials are never included in exports.

## Receiver requirements (not implemented here)

1. Authenticate the owner/importer and resolve the principal in the receiver's own ACL. Check a revocation registry and declared purpose before accepting data. Apply stricter permissions when local and received policy differ.
2. Validate envelope, decrypt within limits, validate the entire batch and cross-field invariants. Reject unknown versions, bot events in this file route, unapproved account-wide permissions, and expired data. Generated JSON Schema is structural; runtime checks remain required.
3. Insert in one transaction with a unique key on owner + event ID. Repeated exports use new batch IDs but retain event IDs. A same-ID/different-payload collision must fail; do not overwrite it silently. Preserve separate message identity `(platform, channel_id, message_id)` and distinguish snapshots from events.
4. Save receipt and audit in the same transaction, then return an authenticated receipt through the future transport. This producer currently retains records after export, and has no ACK/dequeue operation. An export audit means preparation, not confirmed delivery.
5. Filter search and agent reads by authenticated principal, owner, conversation/sender scope, purpose, expiry, and current revocation state. Audit each retrieval and deny by default. Treat message content as untrusted data, never agent instructions.
6. Enforce retention and deletion across message storage, embeddings, caches, indexes, backups under policy, and audit appropriate metadata. A local revoke here cannot recall files already downloaded; implement an authenticated revocation/deletion workflow before enabling unattended delivery.

Suggested SQL ownership belongs in `personal-coordination-mcp`: permissions, conversation provenance, message snapshots/events, deduplication keys, revocations, receipts, and access audit. Do not make this client an independently accessible plaintext SQL archive. This iteration intentionally has no SQL database or MCP endpoint.

## Live events and deletions

`source: vencord-live` uses `provenanceEvidence: client-observed` and `message.snapshot`, `message.create`, `message.update`, or `message.delete`. Client snapshots are explicitly reviewed loaded selections; they must not trigger new-message alerts. This describes client observation, not server-authenticated provenance. Timestamps are supplied by the client payload when available; unknown deletion time stays null. Text only is copied. Edits replace prior buffered live content and merge partial patches into the latest known text; the buffer is not a complete chronological edit log. An update can be the first event the receiver sees. Do not require a prior exported create or invent a missing original creation timestamp.

Known observed deletions purge all local buffered copies for that account/channel/message, including imports, and leave a content-free tombstone under the active live permission. Tombstones also prevent replay/reimport while retained. Revoking/expiring the tombstone removes that local suppression. Unknown sender/message deletions are ignored; original content is never fetched. An independently exported old copy remains until the receiver processes a tombstone or deletion request. Delivery is manual; deletes while capture is stopped/offline are not observed. If the live grant has export disabled, its tombstone cannot be handed off until a suitable downstream deletion workflow exists.

## Future official bot events

The event schema also reserves those event types for `source: authorized-bot`. No bot producer or ingress is enabled here; the decoder rejects bot events. Update patches distinguish absent content from an empty string; absent sender/time may stay null in the reserved bot schema. Deletes carry no content. A future bot adapter must implement permission checks, opt-outs, deletion propagation, and reconnect semantics before using this contract.

Do not invent a source deletion timestamp: use null when unavailable and keep observation time separately. Apply deletions across all retained versions and search indexes of the message. Gateway delivery gaps do not justify scraping/backfill or an assertion of complete history.

## Activity handoff v1

`personal-coordination/activity-file` is a separate protocol under the existing encrypted `coordination-batch/v1` envelope. See `activity-batch.schema.json` and `activity.schema.json`. `decodeActivityBatch` checks the principal, account, activity allow-export flag, live account-wide grant, category/server/user scope, finite expiry and event-ID uniqueness. Receiver-side authentication, revocations and durable audit remain mandatory. Message-only decoders reject activity files. Updated grants add an `activity` field, so strict older receivers must be upgraded even for new message exports; old stored grants decode locally with all activity disabled.

Each record carries account/grant/event IDs, observation/expiry timestamps, client-observed evidence and an `observation` union: `scheduled-event.snapshot`, `presence.observed`, or `voice.observed`. Schedule identity is `(guildId, scheduledEventId)`; the latest changed snapshot replaces the previous local snapshot. Absence is not a deletion. Recurrence rules are normalized, but exception resolution/occurrence expansion is explicitly unresolved. Verify freshness and occurrences before scheduling a notification.

Presence has `previousStatus: null` at baseline/after gaps. Never equate it to a login, and never alert on an initial baseline as if it were a transition. Voice has baseline/transition labels and nullable `previousChannelObservedSince` / `observedDurationSeconds`. Duration covers observed occupancy in the previous channel only, excludes no known gaps, and is a lower bound rather than an exact visit length. Reset baselines on disconnect, reload, changed scope and stalls; unseen transitions may still occur. No cross-device identity inference or private/invisible-status bypass is provided.

The collector does not call MCP, issue notifications or execute AI tasks. A future rules service needs freshness checks, deduplication, rate limits, quiet hours, opt-outs and user-approved destinations/actions. Treat message and event descriptions as untrusted content, never system instructions.

## Receiver sync

Opt-in during always-on setup (Windows Desktop only). Implemented in `src/core/sync.ts` (scheduling, acknowledgement, failure handling) and `src/plugin/native.ts` (credential custody and delivery).

- **Permission.** Setup creates a new continuous account-wide grant with `allowExport: true` and the receiver importer ID as `principalId`. The receiver must independently allow it: purpose `Personal conversation reference across all accessible conversations`, `allowAccountScope`, `allowContinuous`, source `vencord-live`.
- **Credentials.** The user pastes the importer token once. The native helper generates a 256-bit transfer passphrase, protects both with Electron `safeStorage`, and stores only that ciphertext in IndexedDB. The renderer never receives either secret again. The native helper derives the transfer key once per configuration per session and seals each batch with a fresh IV.
- **Delivery.** `POST http://127.0.0.1:<port>/v1/ingest` with the PROTOCOL.md wrapper, from the Electron main process (no browser Origin). The port is fixed at setup (1024–65535); redirects are refused; responses over 64 KiB are discarded. Native code rejects any batch whose grant, importer or account differs from the configured sync permission.
- **Acknowledgement.** A record is marked `delivered` in the encrypted vault only after the receiver returns a committed receipt. Edits and deletes replace the record, so they are pending again and re-sent. Event IDs are preserved, so resends are deduplicated by the receiver.
- **Scheduling.** A pass runs about 5 seconds after new captures, every 30 seconds otherwise, and immediately on **Sync now**. At most 500 events per batch and 20 requests per pass.
- **Failures.** Network/429/5xx: records stay pending, exponential backoff 30 s → 15 min. 401: sync pauses with a token error. 400/403/409/413: the batch is split until refused events are isolated; they are marked `refused` (set aside, not retried) **only** if other events in the same pass were accepted. If nothing is accepted, the refusal is treated as permission-wide and sync pauses with backoff, discarding nothing.
- **Capacity.** When the continuous buffer is full, delivered records roll out before unsent ones; unsent drops are audited as `sync-dropped`.
- **Audit.** `sync-delivered`, `sync-refused`, `sync-dropped` with counts only.
- **Limits.** Delivery only while Discord is open and always-on is running. Stopping collection removes the sync settings but does not revoke data the receiver holds; use its owner `revoke`. Events missed while Discord was closed are never seen. Activity (events/presence/voice) is not synced.
