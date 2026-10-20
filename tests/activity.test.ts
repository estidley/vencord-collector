import test from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../src/core/collector";
import { ActivityCapture, scheduledSnapshot } from "../src/core/activity";
import { noActivity } from "../src/core/activity-schema";
import { LiveCapture } from "../src/core/live";
import { decodeActivityBatch, decodeBatch } from "../src/core/connector";
import { derive, open, seal } from "../src/core/crypto";
import { stateSchema, grantDraftSchema } from "../src/core/schema";
import { MemoryStorage, NOW, PASSWORD, TRANSFER, draft, provenance } from "./fixtures";

const scheduled = { id: "400", guild_id: "500", channel_id: null, creator_id: "600", name: "Game night",
    description: "Bring dice", scheduled_start_time: "2026-10-22T19:00:00Z", scheduled_end_time: null, status: 1,
    entity_metadata: { location: "Club room" }, recurrence_rule: null };
const permission = { scheduledEvents: true, presence: true, voice: true, guildIds: ["500"], userIds: ["600"], allowExport: true };
async function fixture() {
    const storage = new MemoryStorage(); let now = NOW, account = "100000000000000001", presence: unknown = "online", voice: string | undefined = "700";
    const collector = new Collector(storage, () => now); await collector.unlock(PASSWORD);
    const live = new LiveCapture(collector, { accountId: () => account, selectedChannelId: () => provenance.channelId, provenance: () => provenance }, () => now);
    const grant = await collector.grant(live.allDraft(true), true); await live.start(grant.grantId, true, true);
    let reads = 0;
    const engine = new ActivityCapture(collector, live, { accountId: () => account,
        scheduledEvents: () => { reads++; return [scheduled]; }, presence: () => { reads++; return presence; }, voice: () => { reads++; return voice; }, guildForChannel: () => "500" }, () => now);
    const state = async () => stateSchema.parse(await open(storage.value!.envelope, await derive(PASSWORD, storage.value!.envelope.salt), "collector-vault/v1"));
    return { collector, live, grant, storage, engine, state, reads: () => reads,
        advance: (ms: number) => now += ms, setPresence: (v: unknown) => presence = v, setVoice: (v: string | undefined) => voice = v,
        switchAccount: () => account = "999", now: () => now };
}

test("old vaults and permissions opt out of activity; host data is not read until separately authorized", async () => {
    const f = await fixture(); f.engine.poll(); await f.engine.drained();
    assert.equal(f.reads(), 0); assert.equal(f.collector.status().activityCount, 0);
    assert.deepEqual(grantDraftSchema.parse(draft()).activity, noActivity());
    assert.deepEqual(stateSchema.parse({ version: 1, grants: [], records: [], audit: [] }).activities, []);
    await assert.rejects(f.collector.configureActivity(f.grant.grantId, permission, false));
    await f.collector.configureActivity(f.grant.grantId, permission, true); f.advance(5000); f.engine.poll(); await f.engine.drained();
    assert.equal(f.collector.status().activityCount, 3);
    assert.ok(!JSON.stringify(f.storage.value).includes("Game night")); f.live.stop();
});

test("cached schedules deduplicate, preserve cancellation and recurrence uncertainty without inventing occurrences", () => {
    const o = scheduledSnapshot({ ...scheduled, status: 4, recurrence_rule: { start: scheduled.scheduled_start_time, frequency: 2, interval: 1, by_weekday: [2] } })!;
    assert.equal(o.status, "cancelled"); assert.deepEqual(o.recurrence?.byWeekday, [2]); assert.equal(o.recurrenceExceptionsUnresolved, true);
    assert.equal(scheduledSnapshot({ ...scheduled, scheduled_start_time: "bad" }), undefined);
});

test("presence observes changes only; unknown state and reconnect do not imply login or logout", async () => {
    const f = await fixture(); await f.collector.configureActivity(f.grant.grantId, { ...permission, voice: false }, true);
    f.engine.poll(); await f.engine.drained(); f.advance(5000); f.engine.poll(); await f.engine.drained();
    assert.equal(f.collector.status().activityCount, 2);
    f.setPresence("offline"); f.advance(5000); f.engine.poll(); await f.engine.drained();
    let events = (await f.state()).activities.map(e => e.observation).filter(e => e.type === "presence.observed");
    assert.equal(events[1]?.previousStatus, "online");
    f.setPresence(undefined); f.advance(5000); f.engine.poll(); await f.engine.drained();
    assert.equal(f.collector.status().activityCount, 3);
    f.engine.connection(false); f.setPresence("online"); f.advance(5000); f.engine.poll(); await f.engine.drained();
    assert.equal(f.collector.status().activityCount, 3);
    f.engine.connection(true); f.engine.poll(); await f.engine.drained();
    events = (await f.state()).activities.map(e => e.observation).filter(e => e.type === "presence.observed");
    assert.equal(events.at(-1)?.previousStatus, null); f.live.stop();
});

test("voice intervals are observed lower bounds, reset after reconnect, and scoped to chosen people and servers", async () => {
    const f = await fixture(); await f.collector.configureActivity(f.grant.grantId, { ...permission, presence: false, scheduledEvents: false }, true);
    f.engine.poll(); await f.engine.drained(); f.advance(10_000);
    f.engine.voiceUpdates({ voiceStates: [{ userId: "600", oldChannelId: "700", channelId: "701" }, { guildId: "500", userId: "601", channelId: "701" }] });
    await f.engine.drained();
    let events = (await f.state()).activities.map(e => e.observation).filter(e => e.type === "voice.observed");
    assert.equal(events.length, 2); assert.equal(events[1]?.observedDurationSeconds, 10);
    f.engine.connection(false); f.advance(600_000); f.engine.connection(true);
    f.engine.voiceUpdates({ voiceStates: [{ userId: "600", oldChannelId: "701" }] }); await f.engine.drained();
    events = (await f.state()).activities.map(e => e.observation).filter(e => e.type === "voice.observed");
    assert.equal(events.at(-1)?.observedDurationSeconds, null); f.live.stop();
});

test("activity export validates principal, scope, duplicate IDs and expiry; revocation removes encrypted activity", async () => {
    const f = await fixture(); await f.collector.configureActivity(f.grant.grantId, permission, true); f.engine.poll(); await f.engine.drained();
    const encrypted = await f.collector.exportActivity(f.grant.grantId, TRANSFER, true);
    const batch = await decodeActivityBatch(encrypted, TRANSFER, "owner", f.now()); assert.equal(batch.events.length, 3);
    await assert.rejects(decodeBatch(encrypted, TRANSFER, "owner", f.now()));
    await assert.rejects(decodeActivityBatch(encrypted, TRANSFER, "stranger", f.now()));
    await assert.rejects(decodeActivityBatch(encrypted, TRANSFER, "owner", f.now() + 8 * 86_400_000));
    batch.events.push(batch.events[0]!);
    const invalid = await seal(batch, await derive(TRANSFER), "coordination-batch/v1");
    await assert.rejects(decodeActivityBatch(invalid, TRANSFER, "owner", f.now()));
    await assert.rejects(f.collector.captureActivity(f.grant.grantId, f.grant.accountId, { type: "presence.observed", userId: "999", status: "online", previousStatus: null }));
    await f.collector.revoke(f.grant.grantId); assert.equal(f.collector.status().unlocked, false);
    await f.collector.unlock(PASSWORD); assert.equal(f.collector.status().activityCount, 0);
});

test("reduced scope erases its observations; account switches stop and lock both capture paths", async () => {
    const f = await fixture(); await f.collector.configureActivity(f.grant.grantId, permission, true); f.engine.poll(); await f.engine.drained();
    await f.collector.configureActivity(f.grant.grantId, { ...permission, presence: false, voice: false }, true);
    assert.equal(f.collector.status().activityCount, 1);
    f.switchAccount(); f.advance(5000); f.engine.poll(); await f.engine.drained(); assert.equal(f.collector.unlocked, false);
});

test("activity storage errors stop collection without a plaintext fallback", async () => {
    const f = await fixture(); await f.collector.configureActivity(f.grant.grantId, permission, true);
    f.storage.fail = true; f.engine.poll(); await f.engine.drained(); assert.equal(f.live.active, false); assert.equal(f.collector.unlocked, false);
});
