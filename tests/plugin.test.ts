import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("plugin loads before host React resolves and exposes only a disabled local-file panel", async () => {
    const built = await build({
        stdin: { contents: 'import plugin from "./src/plugin/index.tsx"; import { init } from "@webpack/common"; export { plugin, init };', resolveDir: process.cwd() },
        bundle: true, write: false, platform: "node", format: "cjs", jsx: "transform", external: ["react"],
        plugins: [{ name: "mock-host", setup(b) {
            b.onResolve({ filter: /^@(webpack\/common|utils\/types)$/ }, args => ({ path: args.path, namespace: "mock" }));
            b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({
                contents: args.path === "@utils/types" ? "export default p => p;" : 'import * as R from "react"; export let React; export function init() { React = R; }',
                resolveDir: resolve(".")
            }));
        } }]
    });
    const mod = { exports: {} as any };
    new Function("module", "exports", "require", built.outputFiles[0]!.text)(mod, mod.exports, createRequire(import.meta.url));
    const { plugin, init } = mod.exports;
    assert.equal(plugin.enabledByDefault, false);
    for (const key of ["flux", "patches", "contextMenus", "onMessageClick", "onBeforeMessageSend", "onBeforeMessageEdit"]) assert.equal(plugin[key], undefined);
    init();
    assert.match(renderToStaticMarkup(React.createElement(plugin.settingsAboutComponent)), /Enable this plugin/);
    plugin.start();
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(plugin.settingsAboutComponent)), /Enable this plugin/);
    plugin.stop();
    assert.match(renderToStaticMarkup(React.createElement(plugin.settingsAboutComponent)), /Enable this plugin/);
});
