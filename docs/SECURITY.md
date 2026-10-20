# Security and lifecycle boundaries

## Encryption at rest

The only persisted application record is an envelope containing the entire vault, plus a monotonically increasing storage revision. AES-256-GCM authenticates the encrypted message text, IDs, provenance, permissions and local audit. PBKDF2-SHA256 derives a non-extractable in-memory key using a random 16-byte salt and 600,000 iterations. Every save uses a fresh 12-byte IV. Algorithm/context/version/KDF parameters are authenticated, and unexpected parameters fail before decryption.

There is no persisted passphrase, key, plaintext index, telemetry, token, error dump, or plaintext fallback. Short passphrases are rejected, but length alone does not guarantee strength. Use a unique random passphrase. Data remains visible in memory while unlocked. JavaScript cannot guarantee zeroization, protection from swap/crash dumps, or destruction of strings retained by its garbage collector.

## Trust boundaries

This protects a locked buffer against casual file inspection; it is not isolation from malicious code running in the same browser/Discord renderer, other extensions/plugins, malware, DevTools, or a compromised OS. The Vencord panel shares the client's trust boundary. The independent app avoids depending on that renderer but still trusts its browser profile and machine.

User-supplied metadata and consent attestations are not externally verified. A passphrase holder can modify/re-encrypt records. The bounded encrypted audit is operational history, not an append-only, independently verifiable compliance log. Failed attempts do not persist content or raw errors; no assertion is made that every denied action is durably audited. A future server must supply authenticated, durable access auditing.

The offline page's CSP denies network connections and remote resources. Its static server binds only 127.0.0.1:4317 by default (`COLLECTOR_PORT` can select another loopback port), checks Host, serves two known files, denies non-GET requests, and cannot read arbitrary paths. The plugin itself performs no network calls; it cannot impose its offline CSP on Discord.

Live mode deliberately holds the vault key in memory while settings are closed or hidden, for up to one hour after explicit start. File-only use retains the five-minute idle/hide/close lock. Stop, disable/reload, logout/account change, session/permission expiry, or capture failure drops the key and queued work. The plugin has no global indicator outside its settings; reopen settings to inspect scope, counts, deadline or errors. Browser/OS suspension can delay timers; the deadline/account are rechecked before accepting another event. Capture never resumes automatically on unlock.

The all-conversations option is a broad permission over every supported conversation and sender delivered to the account, including newly joined channels. It requires authority and risk attestations, defaults to local-only storage and seven-day retention, and cannot be mixed with selected capture in the same session. This increases the amount of sensitive data held while unlocked. A participant-membership change stops selected scope; account scope intentionally includes new participants. It does not prove anyone's consent or waive platform rules.

## Retention, concurrency and deletion

Permissions expire within 30 days; retained records expire after the configured 1–30 days, capped by permission expiry. Edits do not extend retention. Expired records are inaccessible through export and removed on unlock or the next successful mutation/prune. A locked or closed app has no background job: expired ciphertext may remain on disk until it is opened and pruned. No promise of physical secure erasure from browser storage, snapshots or backups is made.

Revoking a permission removes its snapshots from the current vault, disables export and retains minimal permission/audit metadata. Independent permissions can contain independent copies; revoke each applicable permission. Prior exported files and original input files remain outside this vault and require separate deletion. Downloading a handoff is not a verified successful ingestion.

An IndexedDB transaction compares storage revision before saving to prevent silent overwrites across tabs. Conflicts fail with an instruction to lock/unlock. In-flight operations are mutually exclusive per controller; locking cancels operations before their storage transaction begins. A transaction already started may complete, but the key remains dropped and the operation does not return a plaintext result after a lock. No automatic retries run in the background.

Live edits replace older live text. Observed deletes remove matching buffered records across permissions/sources and leave only a known-sender tombstone. Source files, downloaded exports, backups and offline deletions remain outside this guarantee. See [CONNECTOR.md](CONNECTOR.md) for receiver responsibilities.

Capacity is bounded. The live queue accepts at most 1,000 pending events and 2 MiB of serialized event text (metadata and runtime overhead are additional); the vault holds at most 5,000 records / 8 MiB plaintext. Each save re-encrypts the whole vault. High-volume account-wide capture can therefore hit throughput/capacity limits and stop; this is not a durable, complete archive. Validation or persistence failure does not report success. After 100 permission records, a new profile is needed. Account-wide mode uses one permission per new session created by its button, not one per channel. Receiver authorization and SQL/search operations remain out of scope.

## Reporting

Report implementation issues to the repository owner privately and include synthetic reproduction inputs only. Never attach your message files, passphrase, exports, or account credentials to issue reports. An operating bot/service will need a published user support and abuse-reporting channel before deployment.
