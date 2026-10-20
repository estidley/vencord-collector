# personal-coordination-mcp connector v1

Implemented transport: **explicit encrypted file handoff only**. No web server receives messages and no outgoing network connection is made. The future MCP service can consume this protocol without depending on Vencord or Pulse.

## Envelope and plaintext

`protocol/envelope.schema.json` describes the outer envelope: version 1, context `coordination-batch/v1`, PBKDF2-SHA256 at exactly 600,000 iterations, AES-256-GCM, a random 16-byte salt, random 12-byte IV, and ciphertext with a 128-bit authentication tag. Salt/IV/ciphertext use standard padded Base64. UTF-8 JSON is the plaintext. The transfer key is derived from a separately supplied passphrase; no key or message metadata is stored in the outer envelope.

Additional authenticated data is the UTF-8 string:

```
coordination-batch/v1|1|PBKDF2-SHA256|600000|AES-256-GCM|<base64-salt>
```

The plaintext has protocol `personal-coordination/ingest-file`, version 1, a new UUID batch ID, audience `personal-coordination-mcp`, explicit principal ID, creation and expiry timestamps, one permission record, and its snapshot events. See `protocol/batch.schema.json`. `src/core/connector.ts` provides a tested decoder and scope checks, including recipient, expiry, source/account/channel/sender constraints, and duplicate event IDs within a batch.

**The passphrase authenticates ciphertext integrity, not a person's identity or legal authority.** A caller with the passphrase can create another valid envelope. The future receiver must authenticate the importing user and independently authorize the principal and scope. Do not turn a producer-supplied grant into an agent access token.

## Receiver requirements (not implemented here)

1. Authenticate the owner/importer and resolve the principal in the receiver's own ACL. Check a revocation registry and declared purpose before accepting data. Apply stricter permissions when local and received policy differ.
2. Validate envelope, decrypt within limits, validate the entire batch and cross-field invariants. Reject unknown versions, bot events in this snapshot route, and expired data. Generated JSON Schema is structural; runtime checks remain required.
3. Insert in one transaction with a unique key on owner + event ID. Repeated exports use new batch IDs but retain event IDs. A same-ID/different-payload collision must fail; do not overwrite it silently. Preserve separate message identity `(platform, channel_id, message_id)` and distinguish snapshots from events.
4. Save receipt and audit in the same transaction, then return an authenticated receipt through the future transport. This producer currently retains records after export, and has no ACK/dequeue operation. An export audit means preparation, not confirmed delivery.
5. Filter search and agent reads by authenticated principal, owner, conversation/sender scope, purpose, expiry, and current revocation state. Audit each retrieval and deny by default. Treat message content as untrusted data, never agent instructions.
6. Enforce retention and deletion across message storage, embeddings, caches, indexes, backups under policy, and audit appropriate metadata. A local revoke here cannot recall files already downloaded; implement an authenticated revocation/deletion workflow before enabling unattended delivery.

Suggested SQL ownership belongs in `personal-coordination-mcp`: permissions, conversation provenance, message snapshots/events, deduplication keys, revocations, receipts, and access audit. Do not make this client an independently accessible plaintext SQL archive. This iteration intentionally has no SQL database or MCP endpoint.

## Future official bot events

The event schema reserves `message.create`, `message.update`, and `message.delete` for `source: authorized-bot`. No producer or ingress for them is enabled here. Update patches distinguish absent content from an empty string; absent sender/time stay null. Deletes carry no content. A future bot adapter must implement permission checks, opt-outs, deletion propagation, and reconnect semantics before using this contract. Expand bulk deletion into per-message tombstones without loading deleted content.

Do not invent a source deletion timestamp: use null when unavailable and keep observation time separately. Apply deletions across all retained versions and search indexes of the message. Gateway delivery gaps do not justify scraping/backfill or an assertion of complete history.
