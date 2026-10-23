import { build } from "esbuild";
import { mkdir, writeFile, copyFile } from "node:fs/promises";

await mkdir("dist/standalone", { recursive: true });
await mkdir("dist/messageCollector", { recursive: true });
await build({ entryPoints: ["src/standalone.tsx"], outfile: "dist/standalone/app.js", bundle: true, format: "esm", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
// A self-contained userplugin folder with only the two real Vencord imports left external.
await build({ entryPoints: ["src/plugin/index.tsx"], outfile: "dist/messageCollector/index.tsx", bundle: true, format: "esm", target: "es2022", external: ["@utils/types", "@webpack/common"], jsx: "transform", banner: { js: "// SPDX-License-Identifier: GPL-3.0-or-later\n// Generated from src/. Do not edit this bundle.\n// @ts-nocheck" } });
await build({ entryPoints: ["src/plugin/native.ts"], outfile: "dist/messageCollector/native.ts", bundle: true, platform: "node", format: "esm", target: "es2022", external: ["electron"], banner: { js: "// SPDX-License-Identifier: GPL-3.0-or-later\n// @ts-nocheck" } });
await copyFile("LICENSE", "dist/messageCollector/LICENSE");
await copyFile("docs/VENCORD.md", "dist/messageCollector/README.md");
for (const name of ["SECURITY.md", "POLICY.md", "IMPORTS.md", "CONNECTOR.md", "FLOW-REVIEW.md", "DISCORD-DATA.md", "EXPANDED-CAPTURE.md"]) {
    await copyFile(`docs/${name}`, `dist/messageCollector/${name}`);
}
await writeFile("dist/standalone/index.html", `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Conversation import</title></head><body style="margin:32px auto;max-width:900px;padding:0 16px;background:#e5eaf0"><main id="root"></main><script type="module" src="./app.js"></script></body></html>`);
console.log("Built offline app and experimental Vencord userplugin.");
