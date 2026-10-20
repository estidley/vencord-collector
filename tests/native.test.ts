import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { PASSWORD } from "./fixtures";

test("native credential boundary encrypts, binds account, rejects bad inputs, and refuses plaintext fallback", async () => {
    const built = await build({ stdin: { contents: 'export * from "./src/plugin/native.ts"; export { setAvailable } from "electron";', resolveDir: process.cwd() },
        bundle: true, write: false, platform: "node", format: "cjs", define: { "process.platform": '"win32"' },
        plugins: [{ name: "fake-electron", setup(b) {
            b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "mock" }));
            b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: `
                import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
                const key = randomBytes(32); let enabled = true;
                export const setAvailable = value => { enabled = value; };
                export const safeStorage = {
                    isEncryptionAvailable: () => enabled,
                    encryptString: value => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
                        const data = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
                    decryptString: value => { const d = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
                        d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8'); }
                };` }));
        } }] });
    const mod = { exports: {} as any }; new Function("module", "exports", "require", built.outputFiles[0]!.text)(mod, mod.exports, createRequire(import.meta.url));
    const api = mod.exports, config = { version: 1, accountId: "123", grantId: crypto.randomUUID(), passphrase: PASSWORD };
    const cipher = api.protect(null, config);
    assert.ok(!Buffer.from(cipher, "base64").includes(Buffer.from(PASSWORD)));
    assert.deepEqual(api.restore(null, cipher, "123"), config); assert.equal(api.restore(null, cipher, "456"), undefined);
    assert.throws(() => api.protect(null, { ...config, unexpected: "data" }), /Invalid format/);
    assert.throws(() => api.restore(null, "a".repeat(16385), "123"), /Invalid/);
    assert.throws(() => api.restore(null, "AAAA", "123"), /Unable/);
    api.setAvailable(false); assert.equal(api.available(), false); assert.throws(() => api.protect(null, config), /unavailable/);
});
