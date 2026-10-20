# Vencord compatibility artifact

The generated `messageCollector` folder is a custom userplugin for opt-in live capture and file imports. It is disabled by default. The first setup requires a password and explicit acceptance; subsequently accepted always-on capture resumes automatically for the same account. Running a modified Discord client violates Discord's Terms of Service; this is an unofficial, at-your-own-risk route. The standalone app offers file imports without a client modification. This repository does not automatically install or inject Vencord.

## Current APIs inspected

Upstream: [Vendicated/Vencord](https://github.com/Vendicated/Vencord/tree/32c90633ce6a95d7e56c95479efbb431bacf1eac), commit `32c90633ce6a95d7e56c95479efbb431bacf1eac`, inspected 2026-10-19.

- [`src/utils/types.ts`](https://github.com/Vendicated/Vencord/blob/32c90633ce6a95d7e56c95479efbb431bacf1eac/src/utils/types.ts): `definePlugin`, `enabledByDefault`, `settingsAboutComponent`, `start`, `stop`, and `flux`. The plugin manager subscribes/unsubscribes Flux handlers with plugin lifecycle.
- [`xsOverlay`](https://github.com/Vendicated/Vencord/blob/32c90633ce6a95d7e56c95479efbb431bacf1eac/src/plugins/xsOverlay/index.tsx) demonstrates `MESSAGE_CREATE`, optimistic-event filtering, and DM/group-DM channel metadata. This collector also observes `MESSAGE_UPDATE`, `MESSAGE_DELETE`, and `MESSAGE_DELETE_BULK`. Pre-send/pre-edit callbacks are not confirmed events and are not used.
- Cached `ChannelStore`, `GuildStore`, `SelectedChannelStore`, and `UserStore` supply provenance and the current account. No message store is enumerated, no history is requested, and no credential store is accessed.
- [`src/webpack/common/index.ts`](https://github.com/Vendicated/Vencord/blob/32c90633ce6a95d7e56c95479efbb431bacf1eac/src/webpack/common/index.ts): common exports include React. The plugin uses the host's React rather than bundling another renderer.
- [Basic Plugin Setup](https://docs.vencord.dev/plugins/): custom plugins live in `src/userplugins/<camelCaseName>/index.ts(x)` and are built with Vencord; they are not independently installable extensions.
- [Native code](https://docs.vencord.dev/plugins/native/): `native.ts` exposes only Windows credential protection/restore/availability through Electron safeStorage. It exposes no file paths, message access, or network bridge. Persistence remains in IndexedDB.

## Build review

Run `npm ci && npm run build` in this repository. The output `dist/messageCollector/index.tsx` bundles the local implementation and validation library, leaving only `@utils/types` and `@webpack/common` external. It includes a license file and this README. Source type checking occurs before bundling; the generated bundle is JavaScript in a `.tsx` entry and carries `@ts-nocheck` to avoid type-checking esbuild internals.

`npm run typecheck` checks the shared core, UI, tests and standalone entry. To type-check the original plugin entry against actual upstream types as well, run `npm run check:vencord -- /path/to/Vencord` after installing that checkout's dependencies. This writes a temporary check configuration under `dist/verification` without modifying the upstream checkout. React type definitions are pinned to the inspected upstream's 19.1.0 definitions; the factory depends only on the four React APIs it uses.

## Install your custom build

1. Follow [Vencord's custom plugin guide](https://docs.vencord.dev/installing/custom-plugins/) to prepare a Vencord source checkout and its dependencies.
2. Run `npm ci` and `npm run build` in this repository.
3. Copy **the generated folder** `dist/messageCollector` into the Vencord checkout as `src/userplugins/messageCollector`. The entry must be `src/userplugins/messageCollector/index.tsx`, not an extra nested folder. This is not a loadable plugin for the stock prebuilt Vencord installer.
4. In that Vencord checkout, run `pnpm build`, then its `pnpm inject` installer and choose your intended Discord installation. This modifies the installed client; the repository tests do not perform that step.
5. Restart Discord. In Vencord's Plugins settings, enable **MessageCollector** and open its settings panel. Create/unlock a buffer with a unique passphrase.

## Choose a scope and start

**Default Windows Desktop flow:** enter the buffer password once, read the scope, and press **Accept at my own risk and start collecting**. That single action confirms authority and risks and enables continuous account-wide collection. It remembers the password only inside an OS-encrypted record. It automatically resumes the same account when Discord restarts. No repeated acceptance or password entry is required while it remains enabled. **Stop collecting and forget password** disables restart and removes the remembered credential. A native helper is required, so copy the entire generated `messageCollector` folder, including `native.ts`, rebuild Vencord, and fully restart Discord after updating. Restarting only the renderer cannot load a new native helper.

The main view shows capture status and record count. **Advanced** contains file imports, export, permissions, and the optional timed workflows described below. To enter those workflows without automatic capture, open **Advanced: unlock without collecting** on the password screen.

For selected conversations, open the conversation first, click **Use current Discord conversation**, review the sender list/purpose/expiry, attest authority, and save. DM defaults include the account and current participants; guild defaults include only your own sender ID, which you can explicitly edit. Confirm the one-hour unlocked session, then **Start live capture**. Multiple selected conversations can share the same session deadline. DM membership changes stop selected capture for review.

For all conversations, click **Allow all conversations — at my own risk**. Both authority and risk checkboxes are required before **Start all conversations for one hour** is enabled. Account scope includes all senders in supported DMs, group DMs, server text/news channels, text messages in voice/stage channels, and threads delivered to the signed-in account, including newly joined conversations. Forum/media posts use thread provenance. It stores one account-wide permission and actual provenance on each event, with seven-day retention/permission expiry and export off by default. Other channel types and events without attributable metadata are skipped. No voice/audio is recorded. It does not bypass access or client subscription limits. Stop the current session before switching between selected and all-conversations modes.

Optional timed sessions remain active with the panel closed/hidden until their deadline, expiry, stop/lock, logout/account change, disable/reload, or failure; they do not auto-resume. Always-on sessions have no deadline and reuse one ongoing permission across restarts. Their messages retain a finite lifetime (seven days by default), and oldest continuous entries roll out at the 5,000-record / 8 MiB bound. Other permissions' imports are not evicted. Storage/queue failures still stop with an error; missed messages are not recovered. The panel distinguishes continuous collection from timed sessions. Platform rules and delivery gaps apply equally to both.

Files can also be imported in this panel using a separate manual/data-package permission. Capture text is not rendered as HTML; attachment bodies/URLs and embeds are omitted. Live edits replace earlier live text. Observed deletes purge buffered copies across permissions and retain a content-free tombstone, only when the original sender is known and permitted. Unknown messages are not fetched to reconstruct edits or deletes.

The standalone app and Discord have different browser origins/storage profiles. They do not share a buffer. The plugin cannot provide independent isolation from Discord, other plugins, or a compromised renderer. See [SECURITY.md](SECURITY.md).

Build compatibility and actual logged-in Discord testing are separate. See the repository verification report for what was exercised; no live account is used during validation.
