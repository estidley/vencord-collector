import test from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../src/core/collector";
import { LiveCapture } from "../src/core/live";
import { AlwaysOn } from "../src/core/always-on";
import type { AutoConfig, AutoProtection } from "../src/core/auto-config";
import { grantDraftSchema, type State } from "../src/core/schema";
import { decodeBatch } from "../src/core/connector";
import { derive, open, seal } from "../src/core/crypto";
import { MemoryStorage, NOW, PASSWORD, draft, provenance, withGrant } from "./fixtures";

class Remembered {
    value?: string;
    async readAuto() { return this.value; }
    async writeAuto(value: string | undefined) { this.value = value; }
}
// Mock OS encryption boundary. Actual native adapter is separately exercised with a mock Electron API.
function protection(): AutoProtection {
    const protectedValues = new Map<string, AutoConfig>();
    return { available: async () => true,
        protect: async config => { const token = crypto.randomUUID(); protectedValues.set(token, structuredClone(config)); return token; },
        restore: async (token, account) => { const config = protectedValues.get(token); if (!config) throw new Error(); return config.accountId === account ? structuredClone(config) : undefined; } };
}
async function setup(native = protection()) {
    const vault = new MemoryStorage(), saved = new Remembered(); let now = NOW, account = "100000000000000001";
    const c = new Collector(vault, () => now);
    const live = new LiveCapture(c, { accountId: () => account, selectedChannelId: () => provenance.channelId, provenance: () => provenance }, () => now);
    const auto = new AlwaysOn(c, live, saved, () => native, () => account); auto.activate(); await c.unlock(PASSWORD);
    const emit = async (messageId = "1") => { live.receive("MESSAGE_CREATE", { message: { id: messageId, channel_id: provenance.channelId,
        author: { id: account }, timestamp: new Date(now).toISOString(), content: "continuous synthetic content" } }); await live.drained(); };
    return { c, live, auto, vault, saved, native, emit, advance: (ms: number) => { now += ms; }, account: (value: string) => { account = value; auto.accountChanged(); } };
}

test("one acceptance enables ongoing capture beyond one hour and thirty days, with bounded retention", async () => {
    const { auto, live, c, advance, emit } = await setup();
    await assert.rejects(auto.enable(PASSWORD, false, true), /Confirm/);
    await auto.enable(PASSWORD, true, true); await emit();
    advance(31 * 86_400_000); await emit("2");
    assert.equal(live.active, true); assert.equal(live.status().endsAt, null); assert.equal(c.status().count, 1);
    assert.equal(c.status().grants[0]!.expiresAt, null); await auto.disable();
});

test("restart auto-unlocks only the accepted account; stop removes the credential and prevents restart", async () => {
    const { auto, live, c, saved, emit, account } = await setup();
    await auto.enable(PASSWORD, true, true); await emit();
    assert.ok(saved.value); assert.ok(!saved.value.includes(PASSWORD));
    auto.shutdown(); assert.equal(c.unlocked, false); auto.activate(); await auto.restore();
    assert.equal(live.active, true); assert.equal(c.status().count, 1);
    account("999"); await auto.restore(); assert.equal(live.active, false); assert.equal(c.unlocked, false);
    account("100000000000000001"); await auto.restore(); assert.equal(live.active, true);
    await auto.disable(); assert.equal(saved.value, undefined); auto.shutdown(); auto.activate(); await auto.restore(); assert.equal(live.active, false);
});

test("wrong password and unavailable OS encryption never arm auto-start", async () => {
    const { auto, saved, c } = await setup();
    await assert.rejects(auto.enable("incorrect sufficiently long password", true, true), /Cannot decrypt/);
    assert.equal(saved.value, undefined); assert.equal(c.unlocked, false);
    const blocked = await setup({ ...protection(), available: async () => false });
    await assert.rejects(blocked.auto.enable(PASSWORD, true, true), /Windows/); assert.equal(blocked.saved.value, undefined);
});

test("rapid double-click and stop during enable cannot leave capture armed", async () => {
    const { auto, live, saved } = await setup();
    const enabling = auto.enable(PASSWORD, true, true);
    await assert.rejects(auto.enable(PASSWORD, true, true), /already/);
    const stopped = auto.disable(); await assert.rejects(enabling); await stopped;
    assert.equal(saved.value, undefined); assert.equal(live.active, false);
});

test("shutdown during restore cancels the pending unlock", async () => {
    const { auto, saved, c, live } = await setup(); await auto.enable(PASSWORD, true, true); auto.shutdown(); auto.activate();
    const restoring = auto.restore(); auto.shutdown(); await restoring;
    assert.ok(saved.value); assert.equal(c.unlocked, false); assert.equal(live.active, false);
});

test("revoked permission never resumes and corrupted remembered settings fail closed", async () => {
    const { auto, live, c, saved } = await setup(); await auto.enable(PASSWORD, true, true);
    await c.revoke(c.status().grants[0]!.grantId); auto.shutdown(); auto.activate(); await auto.restore();
    assert.equal(live.active, false); assert.equal(c.unlocked, false);
    saved.value = "corrupt"; auto.shutdown(); auto.activate(); await auto.restore(); assert.equal(live.active, false);
});

test("ongoing permissions cannot remove expiry from file imports", () => {
    assert.ok(!grantDraftSchema.safeParse(draft({ continuous: true, expiresAt: null })).success);
    assert.ok(!grantDraftSchema.safeParse(draft({ source: "vencord-live", expiresAt: null })).success);
});

test("failed credential removal locks immediately and explicitly reports that restart could remain armed", async () => {
    const { auto, saved, c, live } = await setup(); await auto.enable(PASSWORD, true, true);
    saved.writeAuto = async () => { throw new Error("disk failure"); };
    await assert.rejects(auto.disable(), /removal failed/);
    assert.equal(c.unlocked, false); assert.equal(live.active, false); assert.ok(saved.value);
    assert.match(auto.status().notice, /before restarting Discord/);
});

test("continuous handoff retains finite message expiry and excludes remembered credentials", async () => {
    const { auto, c, live, emit } = await setup();
    const grant = await c.grant({ ...live.allDraft(true), allowExport: true }, true);
    await live.start(grant.grantId, true, true); await emit();
    const batch = await decodeBatch(await c.export(grant.grantId, "separate synthetic transfer key", true), "separate synthetic transfer key", "owner", NOW);
    assert.equal(batch.grant.expiresAt, null); assert.ok(Number.isFinite(Date.parse(batch.events[0]!.expiresAt)));
    assert.ok(!JSON.stringify(batch).includes(PASSWORD)); assert.ok(!JSON.stringify(batch).includes("passphrase")); auto.shutdown();
});

test("continuous capacity rollover removes oldest own records while preserving imported records", async () => {
    const { auto, c, vault, live, emit } = await setup(); await auto.enable(PASSWORD, true, true); await emit();
    const envelope = vault.value!.envelope, secret = await derive(PASSWORD, envelope.salt);
    const state = await open(envelope, secret, "collector-vault/v1") as State;
    const seed = state.records[0]!;
    state.records = Array.from({ length: 5000 }, (_, i) => ({ digest: seed.digest,
        event: { ...seed.event, messageId: String(i + 1), eventId: crypto.randomUUID() } }));
    const manual = withGrant(); state.grants.push(manual);
    state.records[4999] = { digest: seed.digest, event: { ...seed.event, type: "message.snapshot", source: "manual", grantId: manual.grantId,
        provenanceEvidence: "user-supplied", messageId: "99999", senderId: manual.accountId, createdAt: new Date(NOW).toISOString(), editedAt: null, content: "imported record" } };
    auto.shutdown(); vault.value = { revision: vault.value!.revision + 1, envelope: await seal(state, secret, "collector-vault/v1") };
    auto.activate(); await auto.restore(); await emit("5001"); assert.equal(live.active, true); assert.equal(c.status().count, 5000);
    const after = await open(vault.value!.envelope, secret, "collector-vault/v1") as State;
    assert.ok(!after.records.some(r => r.event.messageId === "1")); assert.ok(after.records.some(r => r.event.messageId === "5001"));
    assert.ok(after.records.some(r => r.event.messageId === "99999"));
    assert.equal(after.audit.at(-1)!.action, "capacity-prune"); await auto.disable();
});
