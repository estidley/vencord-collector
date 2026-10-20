# Security and lifecycle boundaries

## Encryption at rest

The only persisted application record is an envelope containing the entire vault, plus a monotonically increasing storage revision. AES-256-GCM authenticates the encrypted message text, IDs, provenance, permissions and local audit. PBKDF2-SHA256 derives a non-extractable in-memory key using a random 16-byte salt and 600,000 iterations. Every save uses a fresh 12-byte IV. Algorithm/context/version/KDF parameters are authenticated, and unexpected parameters fail before decryption.

There is no persisted passphrase, key, plaintext index, telemetry, token, error dump, or plaintext fallback. Short passphrases are rejected, but length alone does not guarantee strength. Use a unique random passphrase. Data remains visible in memory while unlocked. JavaScript cannot guarantee zeroization, protection from swap/crash dumps, or destruction of strings retained by its garbage collector.

## Trust boundaries

This protects a locked buffer against casual file inspection; it is not isolation from malicious code running in the same browser/Discord renderer, other extensions/plugins, malware, DevTools, or a compromised OS. The Vencord panel shares the client's trust boundary. The independent app avoids depending on that renderer but still trusts its browser profile and machine.

User-supplied metadata and consent attestations are not externally verified. A passphrase holder can modify/re-encrypt records. The bounded encrypted audit is operational history, not an append-only, independently verifiable compliance log. Failed attempts do not persist content or raw errors; no assertion is made that every denied action is durably audited. A future server must supply authenticated, durable access auditing.

The offline page's CSP denies network connections and remote resources. Its static server binds only 127.0.0.1:4317, checks Host, serves two known files, denies non-GET requests, and cannot read arbitrary paths. The plugin itself performs no network calls; it cannot impose its offline CSP on Discord.

## Retention, concurrency and deletion

Permissions expire within 30 days; retained snapshots expire after the configured 1–30 days, capped by permission expiry. Expired records are inaccessible through export and removed on unlock or the next successful mutation/prune. A locked or closed app has no background job: expired ciphertext may remain on disk until it is opened and pruned. No promise of physical secure erasure from browser storage, snapshots or backups is made.

Revoking a permission removes its snapshots from the current vault, disables export and retains minimal permission/audit metadata. Independent permissions can contain independent copies; revoke each applicable permission. Prior exported files and original input files remain outside this vault and require separate deletion. Downloading a handoff is not a verified successful ingestion.

An IndexedDB transaction compares storage revision before saving to prevent silent overwrites across tabs. Conflicts fail with an instruction to lock/unlock. In-flight operations are mutually exclusive per controller; locking cancels operations before their storage transaction begins. A transaction already started may complete, but the key remains dropped and the operation does not return a plaintext result after a lock. No automatic retries run in the background.

Capacity is bounded. Validation or persistence failure commits no new state, and the UI does not report a successful import. Buffer metadata/history is bounded; after 100 grants a new profile is needed, so this is an initial local tool rather than a long-lived archive. Receiver authorization and SQL/search operations are out of scope for this repository.

## Reporting

Report implementation issues to the repository owner privately and include synthetic reproduction inputs only. Never attach your message files, passphrase, exports, or account credentials to issue reports. An operating bot/service will need a published user support and abuse-reporting channel before deployment.
