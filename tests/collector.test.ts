import test from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../src/core/collector";
import { decodeBatch } from "../src/core/connector";
import { derive, open, seal } from "../src/core/crypto";
import { MemoryStorage, NOW, PASSWORD, TRANSFER, draft, input, provenance } from "./fixtures";

async function setup(overrides = {}) {
    const store = new MemoryStorage(); const collector = new Collector(store, () => NOW);
    await collector.unlock(PASSWORD); const grant = await collector.grant(draft(overrides), true);
    return { store, collector, grant };
}

test("default locked; permission and preview confirmations are required", async () => {
    const c = new Collector(new MemoryStorage(), () => NOW);
    await assert.rejects(c.grant(draft(), true), /locked/);
    await c.unlock(PASSWORD);
    await assert.rejects(c.grant(draft(), false), /Confirm/);
    const g = await c.grant(draft(), true);
    await assert.rejects(c.import(input(), g.grantId, false), /confirm/i);
    assert.equal(c.status().count, 0);
});

test("snapshots encrypt all private data; restart unlock and duplicate import work", async () => {
    const { store, collector: c, grant: g } = await setup();
    assert.equal(await c.import(input(), g.grantId, true), 1);
    assert.equal(await c.import(input(), g.grantId, true), 0);
    const disk = JSON.stringify(store.value);
    for (const secret of ["private canary", provenance.channelId, "Personal conversation reference", g.grantId, PASSWORD]) assert.ok(!disk.includes(secret));
    c.lock(); assert.equal(c.status().count, 0);
    const restarted = new Collector(store, () => NOW); await restarted.unlock(PASSWORD);
    assert.equal(restarted.status().count, 1);
    const decrypted = await open(store.value!.envelope, await derive(PASSWORD, store.value!.envelope.salt), "collector-vault/v1") as any;
    assert.equal(decrypted.records[0].event.type, "message.snapshot");
    assert.equal(decrypted.records[0].event.provenanceEvidence, "user-supplied");
});

test("wrong password cannot reset or overwrite existing buffer", async () => {
    const { store, collector: c } = await setup(); const before = structuredClone(store.value); c.lock();
    await assert.rejects(c.unlock("wrong but sufficiently long password"), /Cannot decrypt/);
    assert.deepEqual(store.value, before); assert.equal(c.unlocked, false);
});

test("cross-channel, cross-account, forbidden sender and extra fields fail atomically", async () => {
    const { collector: c, grant: g, store } = await setup(); const before = structuredClone(store.value);
    const altered = JSON.parse(input()); altered.messages[0].senderId = "999";
    for (const text of [input({ accountId: "999" }), input({ provenance: { ...provenance, channelId: "999" } }), JSON.stringify(altered), input({ token: "never accepted" })])
        await assert.rejects(c.import(text, g.grantId, true));
    assert.deepEqual(store.value, before); assert.equal(c.status().count, 0);
});

test("local-only grants and export confirmation are enforced in the core", async () => {
    const { collector: c, grant: g } = await setup(); await c.import(input(), g.grantId, true);
    await assert.rejects(c.export(g.grantId, TRANSFER, true), /local storage only/);
    await assert.rejects(c.export(g.grantId, TRANSFER, false), /Confirm/);
});

test("encrypted handoff validates audience, principal, scope and expiry; retry event IDs stay stable", async () => {
    const { collector: c, grant: g } = await setup({ allowExport: true }); await c.import(input(), g.grantId, true);
    const envelope = await c.export(g.grantId, TRANSFER, true);
    const batch = await decodeBatch(envelope, TRANSFER, "owner", NOW);
    assert.equal(batch.events.length, 1); assert.equal(batch.events[0]!.senderId, g.accountId);
    await assert.rejects(decodeBatch(envelope, TRANSFER, "another-agent", NOW), /not authorized/);
    await assert.rejects(decodeBatch(envelope, TRANSFER, "owner", NOW + 2 * 86_400_000), /expired/);
    const retry = await decodeBatch(await c.export(g.grantId, TRANSFER, true), TRANSFER, "owner", NOW);
    assert.equal(retry.events[0]!.eventId, batch.events[0]!.eventId); assert.notEqual(retry.batchId, batch.batchId);
    const forged = structuredClone(batch); forged.events[0]!.provenance.channelId = "999";
    await assert.rejects(decodeBatch(await seal(forged, await derive(TRANSFER), "coordination-batch/v1"), TRANSFER, "owner", NOW), /outside/);
});

test("revocation deletes content and blocks further imports and exports", async () => {
    const { collector: c, grant: g, store } = await setup({ allowExport: true }); await c.import(input(), g.grantId, true);
    assert.equal(await c.revoke(g.grantId), 1); assert.equal(c.status().count, 0);
    await assert.rejects(c.import(input(), g.grantId, true), /revoked/);
    await assert.rejects(c.export(g.grantId, TRANSFER, true), /revoked/);
    const decoded = await open(store.value!.envelope, await derive(PASSWORD, store.value!.envelope.salt), "collector-vault/v1");
    assert.ok(!JSON.stringify(decoded).includes("private canary"));
    assert.equal(c.status().audit.at(-1)!.action, "revoke");
});

test("expired retention is pruned on unlock, and expired grants cannot be used", async () => {
    let now = NOW; const store = new MemoryStorage(); const c = new Collector(store, () => now);
    await c.unlock(PASSWORD); const g = await c.grant(draft({ expiresAt: new Date(NOW + 86_400_000).toISOString() }), true);
    await c.import(input(), g.grantId, true); c.lock(); now += 2 * 86_400_000;
    await c.unlock(PASSWORD); assert.equal(c.status().count, 0);
    await assert.rejects(c.import(input(), g.grantId, true), /expired/);
    assert.equal(c.status().audit.at(-1)!.action, "prune");
});

test("permission expiration must be future and at most thirty days", async () => {
    const { collector: c } = await setup();
    for (const expiresAt of [new Date(NOW).toISOString(), new Date(NOW + 31 * 86_400_000).toISOString()])
        await assert.rejects(c.grant(draft({ expiresAt }), true), /within/);
});

test("storage failure preserves prior state and never reports successful capture", async () => {
    const { collector: c, grant: g, store } = await setup(); const before = structuredClone(store.value); store.fail = true;
    await assert.rejects(c.import(input(), g.grantId, true), /Storage failed/);
    assert.deepEqual(store.value, before); assert.equal(c.status().count, 0);
});

test("two sessions cannot silently overwrite each other's grants", async () => {
    const { collector: c, store } = await setup(); const second = new Collector(store, () => NOW); await second.unlock(PASSWORD);
    await c.grant(draft({ purpose: "New permission" }), true);
    await assert.rejects(second.grant(draft({ purpose: "Stale permission" }), true), /Concurrent/);
    assert.equal(second.status().grants.length, 1);
});

test("locking during a pending import prevents its commit", async () => {
    const { collector: c, store, grant: g } = await setup(); const before = structuredClone(store.value);
    const pending = c.import(input(), g.grantId, true); c.lock();
    await assert.rejects(pending, /locked/); assert.deepEqual(store.value, before);
});

test("lock cancels pending unlock; plugin stop forbids unlocking", async () => {
    const c = new Collector(new MemoryStorage(), () => NOW);
    const pending = c.unlock(PASSWORD); c.lock(); await assert.rejects(pending, /cancelled/);
    c.suspend(); await assert.rejects(c.unlock(PASSWORD), /Enable/); c.resume(); await c.unlock(PASSWORD);
    assert.equal(c.unlocked, true); c.suspend(); assert.equal(c.unlocked, false);
});

test("full buffer rejects overflow without dropping older messages", async () => {
    const { collector: c, grant: g } = await setup();
    const base = JSON.parse(input());
    for (let group = 0; group < 5; group++) {
        base.messages = Array.from({ length: 1000 }, (_, i) => ({ messageId: String(group * 1000 + i + 1), senderId: g.accountId, createdAt: "2026-10-18T10:00:00Z", editedAt: null, content: "capacity" }));
        await c.import(JSON.stringify(base), g.grantId, true);
    }
    assert.equal(c.status().count, 5000);
    await assert.rejects(c.import(input(), g.grantId, true), /capacity/); assert.equal(c.status().count, 5000);
});
