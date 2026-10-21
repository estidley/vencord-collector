import test from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../src/core/collector";
import { LiveCapture } from "../src/core/live";
import { AlwaysOn } from "../src/core/always-on";
import { SyncController } from "../src/core/sync";
import type { AutoConfig, AutoProtection } from "../src/core/auto-config";
import { batchSchema, type State } from "../src/core/schema";
import type { Delivery, Probe, SyncNative } from "../src/core/sync-config";
import { derive, open, seal } from "../src/core/crypto";
import { MemoryStorage, NOW, PASSWORD, provenance } from "./fixtures";

const TOKEN = "A".repeat(43), SETUP = { principalId: "collector-home", port: 4320, token: TOKEN };
class Remembered {
    auto?: string; sync?: string;
    async readAuto() { return this.auto; }
    async writeAuto(value: string | undefined) { this.auto = value; }
    async readSync() { return this.sync; }
    async writeSync(value: string | undefined) { this.sync = value; }
}
/** Mock native boundary + receiver. The real native adapter and HTTP path are covered in native.test.ts. */
class FakeNative implements AutoProtection, SyncNative {
    private autos = new Map<string, AutoConfig>(); private syncs = new Map<string, Record<string, unknown>>();
    mode: "ok" | "down" | "busy" | "401" | "403" = "ok";
    poison = new Set<string>(); // message IDs the receiver refuses with 409
    received = new Map<string, unknown>(); // eventId -> event
    requests = 0;
    async available() { return true; }
    async protect(config: AutoConfig) { const t = crypto.randomUUID(); this.autos.set(t, structuredClone(config)); return btoa(t); }
    async restore(token: string, account: string) { const c = this.autos.get(atob(token)); if (!c) throw new Error(); return c.accountId === account ? structuredClone(c) : undefined; }
    async protectSync(setup: Record<string, unknown>) { const t = crypto.randomUUID(); this.syncs.set(t, structuredClone(setup)); return btoa(t); }
    private status(): number { return { ok: 200, down: 0, busy: 503, "401": 401, "403": 403 }[this.mode]; }
    async probeSync(blob: string, account: string): Promise<Probe> {
        const c = this.syncs.get(atob(blob)); assert.equal(c?.accountId, account); assert.equal(c?.token, TOKEN);
        const s = this.status(); return s === 200 ? { ok: true, checkpoint: 0 } : { ok: false, kind: s === 401 ? "credentials" : s === 403 ? "refused" : "retry", status: s };
    }
    async deliver(blob: string, account: string, input: unknown): Promise<Delivery> {
        this.requests++;
        const c = this.syncs.get(atob(blob))!, batch = batchSchema.parse(input);
        assert.equal(batch.grant.grantId, c.grantId); assert.equal(batch.principalId, "collector-home"); assert.equal(batch.grant.allowExport, true); assert.equal(account, c.accountId);
        const s = this.status();
        if (s !== 200) return { ok: false, kind: s === 401 ? "credentials" : s === 403 ? "refused" : "retry", status: s };
        if (batch.events.some(e => this.poison.has(e.messageId))) return { ok: false, kind: "refused", status: 409 };
        for (const e of batch.events) this.received.set(e.eventId, e);
        return { ok: true, receipt: { version: 1, receiptId: crypto.randomUUID(), checkpoint: this.requests, accepted: batch.events.length, duplicates: 0, committedAt: new Date(NOW).toISOString() } };
    }
}
async function setup(native = new FakeNative()) {
    const vault = new MemoryStorage(), saved = new Remembered(); let now = NOW; const account = "100000000000000001";
    const c = new Collector(vault, () => now);
    const live = new LiveCapture(c, { accountId: () => account, selectedChannelId: () => provenance.channelId, provenance: () => provenance }, () => now);
    let auto: AlwaysOn;
    const sync = new SyncController(c, saved, () => native, () => account, () => auto.grantId, () => now);
    auto = new AlwaysOn(c, live, saved, () => native, () => account, sync); auto.activate(); await c.unlock(PASSWORD);
    const msg = (id: string, content = `synthetic message ${id}`) => ({ message: { id, channel_id: provenance.channelId, author: { id: account }, timestamp: new Date(now).toISOString(), content } });
    const emit = async (id: string, content?: string) => { live.receive("MESSAGE_CREATE", msg(id, content)); await live.drained(); };
    const edit = async (id: string, content: string) => { live.receive("MESSAGE_UPDATE", { message: { id, channel_id: provenance.channelId, content } }); await live.drained(); };
    const remove = async (id: string) => { live.receive("MESSAGE_DELETE", { channelId: provenance.channelId, id }); await live.drained(); };
    return { c, live, auto, sync, vault, saved, native, emit, edit, remove, advance: (ms: number) => { now += ms; } };
}
const audits = (c: Collector) => c.status().audit.map(a => a.action);

test("sync setup creates its own export-enabled grant, proves the token first, and syncs creates, edits and deletes", async () => {
    const { auto, c, sync, saved, native, emit, edit, remove } = await setup();
    await auto.enable(PASSWORD, true, true, SETUP);
    const grant = c.status().grants.at(-1)!;
    assert.equal(grant.allowExport, true); assert.equal(grant.principalId, "collector-home"); assert.equal(grant.scope, "account"); assert.equal(grant.continuous, true);
    assert.ok(saved.sync); assert.ok(!saved.sync.includes(TOKEN));
    await emit("1"); await emit("2"); assert.equal(c.status().sync.pending, 2);
    await sync.syncNow();
    assert.equal(native.received.size, 2); assert.deepEqual(c.status().sync, { pending: 0, delivered: 2, refused: 0 });
    assert.ok(audits(c).includes("sync-delivered"));
    await edit("1", "edited synthetic text"); assert.equal(c.status().sync.pending, 1);
    await remove("2"); assert.equal(c.status().sync.pending, 2);
    await sync.syncNow();
    const types = [...native.received.values()].map(e => (e as { type: string }).type).sort();
    assert.deepEqual(types, ["message.create", "message.create", "message.delete", "message.update"]);
    assert.equal(c.status().sync.pending, 0); assert.equal(sync.status().state, "idle");
    await auto.disable(); assert.equal(saved.sync, undefined); assert.equal(sync.configured, false);
});

test("a wrong token or missing receiver fails setup closed: nothing armed, no export-enabled collection running", async () => {
    for (const mode of ["401", "down"] as const) {
        const native = new FakeNative(); native.mode = mode;
        const { auto, saved, live } = await setup(native);
        await assert.rejects(auto.enable(PASSWORD, true, true, SETUP), mode === "401" ? /rejected that importer token/ : /No receiver answered/);
        assert.equal(saved.sync, undefined); assert.equal(saved.auto, undefined); assert.equal(live.active, false); assert.equal(auto.grantId, undefined);
    }
    const { auto } = await setup();
    await assert.rejects(auto.enable(PASSWORD, true, true, { ...SETUP, token: "short" }), /Invalid format/);
});

test("receiver outages keep records pending with backoff, then deliver once it returns", async () => {
    const { auto, c, sync, native, emit, advance } = await setup();
    await auto.enable(PASSWORD, true, true, SETUP); await emit("1");
    native.mode = "down"; await sync.syncNow();
    assert.equal(sync.status().state, "error"); assert.match(sync.status().message, /not reachable/); assert.equal(c.status().sync.pending, 1);
    const first = sync.status().nextAttemptAt!;
    native.mode = "busy"; advance(31_000); await sync.tick();
    assert.ok(sync.status().nextAttemptAt! - NOW - 31_000 >= 60_000, "second failure backs off further");
    assert.ok(first > NOW);
    native.mode = "ok"; await sync.tick(); assert.equal(native.received.size, 0, "tick respects backoff");
    advance(16 * 60_000); await sync.tick();
    assert.equal(native.received.size, 1); assert.equal(c.status().sync.pending, 0); assert.equal(sync.status().state, "idle");
    await auto.disable();
});

test("one event the receiver refuses is isolated and set aside without blocking the rest", async () => {
    const { auto, c, sync, native, emit } = await setup();
    await auto.enable(PASSWORD, true, true, SETUP);
    for (let i = 1; i <= 9; i++) await emit(String(i));
    native.poison.add("6");
    await sync.syncNow();
    assert.deepEqual(c.status().sync, { pending: 0, delivered: 8, refused: 1 });
    assert.ok(![...native.received.values()].some(e => (e as { messageId: string }).messageId === "6"));
    assert.ok(audits(c).includes("sync-refused")); assert.match(sync.status().message, /1 refused/);
    assert.ok(native.requests <= 20);
    await auto.disable();
});

test("a permission-wide refusal or bad token pauses sync without discarding or setting anything aside", async () => {
    for (const mode of ["403", "401"] as const) {
        const { auto, c, sync, native, emit } = await setup();
        await auto.enable(PASSWORD, true, true, SETUP);
        for (let i = 1; i <= 40; i++) await emit(String(i));
        native.mode = mode; await sync.syncNow();
        assert.deepEqual(c.status().sync, { pending: 40, delivered: 0, refused: 0 });
        assert.equal(sync.status().state, "error");
        assert.match(sync.status().message, mode === "401" ? /rejected the sync token/ : /refused these records \(HTTP 403\)/);
        assert.ok(native.requests <= 20, "bounded requests per pass");
        await auto.disable();
    }
});

test("sync resumes after restart, follows the restored grant, and enabling without sync removes stale settings", async () => {
    const { auto, c, sync, saved, native, emit, live } = await setup();
    await auto.enable(PASSWORD, true, true, SETUP); await emit("1");
    auto.shutdown(); assert.equal(auto.grantId, undefined);
    await sync.syncNow(); assert.equal(sync.status().state, "waiting"); assert.equal(native.received.size, 0);
    auto.activate(); await auto.restore(); assert.equal(live.active, true); assert.ok(auto.grantId);
    await sync.syncNow(); assert.equal(native.received.size, 1);
    // A later plain always-on enable must not leave the old receiver configuration armed.
    await auto.disable(); saved.sync = "c3RhbGU="; await c.unlock(PASSWORD);
    await auto.enable(PASSWORD, true, true); assert.equal(saved.sync, undefined);
    assert.equal(c.status().grants.at(-1)!.allowExport, false);
    await auto.disable();
});

test("full buffer drops records the receiver already holds before unsent ones, and audits unsent drops", async () => {
    const { auto, c, sync, vault, emit } = await setup();
    await auto.enable(PASSWORD, true, true, SETUP); await emit("999999"); await sync.syncNow();
    const envelope = vault.value!.envelope, secret = await derive(PASSWORD, envelope.salt);
    const state = await open(envelope, secret, "collector-vault/v1") as State, seed = state.records[0]!;
    const fill = (delivered: (i: number) => boolean) => Array.from({ length: 5000 }, (_, i) => ({ digest: seed.digest,
        event: { ...seed.event, messageId: String(i + 1), eventId: crypto.randomUUID() },
        ...(delivered(i) ? { sync: { outcome: "delivered" as const, at: new Date(NOW).toISOString() } } : {}) }));
    const reload = async (records: State["records"]) => {
        auto.shutdown(); state.records = records;
        vault.value = { revision: vault.value!.revision + 1, envelope: await seal(state, secret, "collector-vault/v1") };
        auto.activate(); await auto.restore();
    };
    await reload(fill(i => i >= 100 && i < 110)); await emit("5001");
    let after = await open(vault.value!.envelope, secret, "collector-vault/v1") as State;
    assert.ok(after.records.some(r => r.event.messageId === "1"), "oldest unsent record kept");
    assert.ok(!after.records.some(r => r.event.messageId === "101"), "oldest delivered record dropped");
    assert.equal(after.audit.at(-1)!.action, "capacity-prune");
    await reload(fill(() => false)); await emit("5002");
    after = await open(vault.value!.envelope, secret, "collector-vault/v1") as State;
    assert.ok(!after.records.some(r => r.event.messageId === "1"));
    assert.equal(after.audit.at(-1)!.action, "sync-dropped"); assert.equal(after.audit.at(-1)!.count, 1);
    await auto.disable();
});

test("manual export still works for a sync-enabled grant", async () => {
    const { c, auto, emit, sync } = await setup();
    await auto.enable(PASSWORD, true, true, SETUP); await emit("1"); await sync.syncNow();
    const grant = c.status().grants.at(-1)!;
    const envelope = await c.export(grant.grantId, "different transfer passphrase", true);
    assert.equal(envelope.context, "coordination-batch/v1");
    await auto.disable();
});
