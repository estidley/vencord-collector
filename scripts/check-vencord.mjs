import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, parse } from "node:path";
import { spawnSync } from "node:child_process";

const checkout = process.argv[2];
if (!checkout) throw new Error("Pass the path to a Vencord source checkout with dependencies installed.");
const root = resolve(checkout);
await readFile(resolve(root, "tsconfig.json"));
await mkdir("dist/verification", { recursive: true });
const config = resolve("dist/verification/vencord-source.json");
await writeFile(config, JSON.stringify({
    extends: resolve(root, "tsconfig.json"),
    compilerOptions: { skipLibCheck: true, allowJs: false, rootDir: parse(resolve(".")).root },
    include: [resolve("src/plugin/index.tsx"), resolve("src/plugin/native.ts"), ...["globals.d.ts", "modules.d.ts", "nativeModules.d.ts"].map(f => resolve(root, "src", f))]
}, null, 2));
const result = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", config], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
