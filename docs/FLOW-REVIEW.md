# Adversarial review of automatic collection

The intended Windows Desktop flow is one password field and one **Accept at my own risk and start collecting** button. The text beside it explains account-wide scope, authority/participant permission, client-modification risk, remembered credentials, rolling retention and local-only storage. Acceptance enables collection until stopped or revoked. Advanced workflows are collapsed. This is an implementation review with synthetic tests, not an independent security assessment or live-account certification.

| Challenge | Expected behavior and checks |
|---|---|
| Enter a password but do not accept | No capture starts. Browser test checks before pressing the button. |
| Submit the wrong password | Existing vault is not reset; no automatic credential is armed. |
| Double-click or stop during setup | Single serialized setup; cancellation invalidates pending work and removes any newly saved credential. Fixed during review. |
| Close settings or leave Discord running overnight | Continuous mode has no hourly cutoff. Tests advance beyond an hour and beyond 30 days; message retention still applies. |
| Restart Discord | Same account restores using protected credentials and the original grant; no password/acceptance prompt. Browser reload covers the UI flow. |
| Switch Discord accounts | Old key is dropped; remembered credentials are not returned for a different account. No transfer of consent to the new account. |
| Stop, then restart | Stop deletes the protected credential and locks immediately; startup remains off. Failed deletion is visibly reported. |
| Revoke an ongoing permission | Local content is removed; stale remembered grants cannot restart. Fixed a lock-before-revoke loop during review. |
| OS protection unavailable or corrupt | No plaintext fallback; explicit error and no capture. Native API harness rejects malformed inputs and wrong account IDs. |
| Fill the buffer | Continuous records roll out with an audit; unrelated imports are preserved. Disk/queue failures still pause rather than claiming success. |
| Export ongoing data | Only finite-retention events are included, never auto-unlock credentials. Receiver must independently authorize ongoing scope. |
| Compromise another plugin / same Windows user | Remains outside the isolation boundary. It may access decrypted content or the credential bridge. |

Remaining limits: no offline/history recovery; no guarantee that Discord delivers every channel event; pending events during shutdown can be lost; native Windows DPAPI in a real logged-in Discord process has not been exercised. Production source/build compatibility and synthetic UI/security behavior are checked separately.
