import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createServer, type IncomingMessage } from "node:http";
import { PASSWORD } from "./fixtures";
import { derive, open } from "../src/core/crypto";
import { batchSchema } from "../src/core/schema";

async function loadNative() {
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
    return mod.exports;
}

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

const body = (req: IncomingMessage) => new Promise<string>(r => { let s = ""; req.on("data", c => s += c); req.on("end", () => r(s)); });
test("native sync delivers sealed batches only to loopback, keeps secrets inside, and classifies receiver answers", async t => {
    const api = await loadNative(), token = "T".repeat(43), account = "100000000000000001", grantId = crypto.randomUUID();
    let reply = 200; const seen: { auth?: string; host?: string; origin?: string; batch?: unknown; passphrase?: string }[] = [];
    const server = createServer(async (req, res) => {
        const entry: typeof seen[number] = { auth: req.headers.authorization, host: req.headers.host, origin: req.headers.origin as string | undefined };
        seen.push(entry);
        if (req.method === "GET") { res.writeHead(reply, { "Content-Type": "application/json" }); res.end(JSON.stringify({ version: 1, checkpoint: 0 })); return; }
        const parsed = JSON.parse(await body(req)); entry.passphrase = parsed.transferPassphrase;
        entry.batch = await open(parsed.envelope, await derive(parsed.transferPassphrase, parsed.envelope.salt), "coordination-batch/v1");
        res.writeHead(reply, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply === 200 ? { version: 1, receiptId: crypto.randomUUID(), checkpoint: 7, accepted: 1, duplicates: 0, committedAt: new Date().toISOString() } : { error: "denied" }));
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
    const port = (server.address() as { port: number }).port;
    const blob = api.protectSync(null, { principalId: "collector-home", port, token, accountId: account, grantId });
    assert.ok(!Buffer.from(blob, "base64").includes(Buffer.from(token)));
    assert.throws(() => api.protectSync(null, { principalId: "collector-home", port, token, accountId: account, grantId, transferPassphrase: "x".repeat(43) }), /Invalid format/);
    assert.throws(() => api.protectSync(null, { principalId: "collector-home", port: 80, token, accountId: account, grantId }), /Invalid format/);
    assert.deepEqual(await api.probeSync(null, blob, account), { ok: true, checkpoint: 0 });
    await assert.rejects(api.probeSync(null, blob, "999"), /another Discord account/);
    const now = new Date(), later = new Date(Date.now() + 86_400_000).toISOString();
    const provenance = { kind: "dm", guildId: null, guildName: null, channelId: "200000000000000001", channelName: null, parentChannelId: null, threadId: null, participantIds: [account] };
    const grant = { source: "vencord-live", accountId: account, scope: "account", provenance: null, allowedSenderIds: [], purpose: "Personal conversation reference across all accessible conversations",
        continuous: true, expiresAt: null, retentionDays: 7, allowExport: true, principalId: "collector-home", grantId, grantedAt: now.toISOString(), authority: "user-attested", revokedAt: null };
    const batch = batchSchema.parse({ protocol: "personal-coordination/ingest-file", version: 1, batchId: crypto.randomUUID(), createdAt: now.toISOString(), expiresAt: later,
        audience: "personal-coordination-mcp", principalId: "collector-home", grant, events: [{ version: 1, type: "message.create", eventId: crypto.randomUUID(), messageId: "300",
            source: "vencord-live", accountId: account, provenance, provenanceEvidence: "client-observed", grantId, observedAt: now.toISOString(), expiresAt: later,
            sourceTimestamp: now.toISOString(), senderId: account, createdAt: now.toISOString(), content: "synthetic native sync text" }] });
    const ok = await api.deliver(null, blob, account, batch);
    assert.equal(ok.ok, true); assert.equal(ok.receipt.checkpoint, 7);
    assert.ok(!JSON.stringify(ok).includes(token));
    const posted = seen.at(-1)!;
    assert.equal(posted.auth, `Bearer ${token}`); assert.equal(posted.host, `127.0.0.1:${port}`); assert.equal(posted.origin, undefined);
    assert.deepEqual(posted.batch, batch); assert.match(posted.passphrase!, /^[A-Za-z0-9_-]{43}$/);
    await api.deliver(null, blob, account, { ...batch, batchId: crypto.randomUUID() });
    assert.equal(seen.at(-1)!.passphrase, posted.passphrase, "one generated transfer passphrase per configuration");
    // The renderer cannot redirect delivery to another grant, importer or account.
    await assert.rejects(api.deliver(null, blob, account, batchSchema.parse({ ...batch, principalId: "someone-else", grant: { ...grant, principalId: "someone-else" } })), /does not match/);
    const other = crypto.randomUUID();
    await assert.rejects(api.deliver(null, blob, account, batchSchema.parse({ ...batch, grant: { ...grant, grantId: other }, events: batch.events.map(e => ({ ...e, grantId: other })) })), /does not match/);
    await assert.rejects(api.deliver(null, blob, account, { ...batch, extra: true }), /Invalid format/);
    for (const [status, kind] of [[401, "credentials"], [403, "refused"], [409, "refused"], [429, "retry"], [503, "retry"]] as const) {
        reply = status; assert.deepEqual(await api.deliver(null, blob, account, batch), { ok: false, kind, status });
    }
    server.close(); reply = 200;
    assert.deepEqual(await api.deliver(null, blob, account, batch), { ok: false, kind: "retry", status: 0 });
});
