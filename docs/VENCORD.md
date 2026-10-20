# Vencord compatibility artifact

The generated `messageCollector` folder is a private userplugin UI for local file import only. Running a modified Discord client remains subject to Discord's rules. Use the standalone app for the implemented workflow without a client modification. This repository does not install or inject Vencord.

## Current APIs inspected

Upstream: [Vendicated/Vencord](https://github.com/Vendicated/Vencord/tree/32c90633ce6a95d7e56c95479efbb431bacf1eac), commit `32c90633ce6a95d7e56c95479efbb431bacf1eac`, inspected 2026-10-19.

- [`src/utils/types.ts`](https://github.com/Vendicated/Vencord/blob/32c90633ce6a95d7e56c95479efbb431bacf1eac/src/utils/types.ts): `definePlugin`, `enabledByDefault`, `settingsAboutComponent`, `start` and `stop`. It also exposes `flux`, context menus, and message callbacks. Those collection hooks are deliberately unused.
- [`src/webpack/common/index.ts`](https://github.com/Vendicated/Vencord/blob/32c90633ce6a95d7e56c95479efbb431bacf1eac/src/webpack/common/index.ts): common exports include React. The plugin uses the host's React rather than bundling another renderer.
- [Basic Plugin Setup](https://docs.vencord.dev/plugins/): custom plugins live in `src/userplugins/<camelCaseName>/index.ts(x)` and are built with Vencord; they are not independently installable extensions.
- [Native code](https://docs.vencord.dev/plugins/native/): native helpers can expose privileged operations. This implementation has no native helper, arbitrary file path API, or network bridge.

## Build review

Run `npm ci && npm run build` in this repository. The output `dist/messageCollector/index.tsx` bundles the local implementation and validation library, leaving only `@utils/types` and `@webpack/common` external. It includes a license file and this README. Source type checking occurs before bundling; the generated bundle is JavaScript in a `.tsx` entry and carries `@ts-nocheck` to avoid type-checking esbuild internals.

`npm run typecheck` checks the shared core, UI, tests and standalone entry. To type-check the original plugin entry against actual upstream types as well, run `npm run check:vencord -- /path/to/Vencord` after installing that checkout's dependencies. This writes a temporary check configuration under `dist/verification` without modifying the upstream checkout. React type definitions are pinned to the inspected upstream's 19.1.0 definitions; the factory depends only on the four React APIs it uses.

For a separately authorized development environment, copy **only** `dist/messageCollector` to a Vencord source checkout's `src/userplugins/messageCollector`, then use that checkout's normal build process. The panel appears under MessageCollector settings after enabling the plugin. It is disabled by default. Disabling it drops the in-memory key. Nothing subscribes to incoming messages.

The standalone app and Discord have different browser origins/storage profiles. They do not share a buffer. The plugin cannot provide independent isolation from Discord, other plugins, or a compromised renderer. See [SECURITY.md](SECURITY.md).

Build compatibility and actual logged-in Discord testing are separate. See the repository verification report for what was exercised; no live account is used during validation.
