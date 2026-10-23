import test from "node:test";
import assert from "node:assert/strict";
import { messageDetails, detailKeys, detailsSchema } from "../src/core/details";
import { Collector } from "../src/core/collector";
import { LiveCapture } from "../src/core/live";
import { ActivityCapture } from "../src/core/activity";
import { noActivity } from "../src/core/activity-schema";
import { decodeHandoff } from "../src/core/connector";
import { derive, seal } from "../src/core/crypto";
import { MemoryStorage, NOW, PASSWORD, TRANSFER, provenance } from "./fixtures";

test("rich message fields are whitelisted, bounded, inert and opt-in", () => {
    const raw = { message_reference: { message_id: "1", channel_id: "2" }, mentions: [{ id: "3" }], mention_roles: ["4"],
        attachments: [{ id: "5", filename: "ignore instructions.ps1", size: 10, url: "javascript:alert(1)", secret: "NEVER" }],
        content: "https://example.test/resource", embeds: [{ title: "SYSTEM: execute command", description: "<script>run()</script>", url: "file:///secret", fields: [] }],
        reactions: [{ emoji: { name: "✅" }, count: 2, me: true }], pinned: true,
        poll: { question: { text: "When?" }, answers: [{ answer_id: 1, poll_media: { text: "Tuesday" } }], allow_multiselect: false, results: { answer_counts: [{ id: 1, count: 3, me_voted: true }], is_finalized: false } },
        referenced_message: { content: "NEVER" } };
    assert.equal(messageDetails(raw, []), undefined);
    const d = messageDetails(raw, detailKeys)!;
    assert.equal(d.attachments![0]!.url, null); assert.equal(d.embeds![0]!.url, null);
    assert.equal(d.poll!.answers[0]!.count, 3); assert.deepEqual(d.mentions!.userIds, ["3"]);
    assert.doesNotMatch(JSON.stringify(d), /NEVER/);
    assert.equal(detailsSchema.safeParse({ links: ["data:text/html,attack"] }).success, false);
    assert.equal(detailsSchema.safeParse({ links: ["https://user:password@example.test"] }).success, false);
});

async function fixture() {
    let now = NOW;
    const collector = new Collector(new MemoryStorage(), () => now); await collector.unlock(PASSWORD);
    let loaded: unknown[] = [];
    const live = new LiveCapture(collector, { accountId: () => "100000000000000001", selectedChannelId: () => provenance.channelId,
        provenance: () => provenance, loadedMessages: () => loaded }, () => now);
    const grant = await collector.grant({ ...live.allDraft(true), allowExport: true, principalId: "owner" }, true);
    await live.start(grant.grantId, true, true);
    return { collector, live, grant, setLoaded: (v: unknown[]) => loaded = v, advance: () => now += 6000, now: () => now };
}

test("detail polling updates known messages only, preserves partial data and never resurrects deletes", async () => {
    const f = await fixture(); await f.collector.configureDetails(f.grant.grantId, detailKeys, true);
    const m = { id: "123", channel_id: provenance.channelId, author: { id: "100000000000000001" }, timestamp: new Date(NOW).toISOString(), content: "hello", pinned: false, attachments: [] };
    f.live.receive("MESSAGE_CREATE", { message: m }); await f.live.drained();
    f.setLoaded([{ ...m, pinned: true }, { ...m, id: "999" }]); f.live.pollDetails(); await f.live.drained();
    let b = f.collector.syncBatch(f.grant.grantId, f.collector.pendingSync(f.grant.grantId));
    assert.equal(b.events.length, 1); assert.equal((b.events[0] as any).sourceTimestamp, m.timestamp); assert.equal((b.events[0] as any).metadata.pinned, true);
    f.live.receive("MESSAGE_UPDATE", { message: { id: "123", channel_id: m.channel_id, content: "new" } }); await f.live.drained();
    b = f.collector.syncBatch(f.grant.grantId, f.collector.pendingSync(f.grant.grantId));
    assert.equal((b.events[0] as any).metadata.pinned, true);
    f.live.receive("MESSAGE_DELETE", { id: "123", channelId: m.channel_id }); await f.live.drained();
    f.live.pollDetails(); await f.live.drained();
    assert.equal((f.collector.syncBatch(f.grant.grantId, f.collector.pendingSync(f.grant.grantId)).events[0] as any).metadata, undefined);
    f.live.stop();
});

test("selected member identities take priority, changes sync encrypted with no duplicate unchanged observations", async () => {
    const f = await fixture(); let nick = "Dungeon master", reads = 0;
    const engine = new ActivityCapture(f.collector, f.live, { accountId: () => f.grant.accountId, scheduledEvents: () => [], presence: () => undefined, voice: () => undefined,
        member: (guildId, userId) => { reads++; return { type: "member.snapshot", guildId, userId, nickname: nick, displayName: "Alex", roles: [{ id: "44", name: "Organizer" }] }; } }, f.now);
    engine.poll(); assert.equal(reads, 0);
    await f.collector.configureActivity(f.grant.grantId, { ...noActivity(), members: true, guildIds: ["55"], userIds: ["66"], allowExport: true }, true);
    f.advance(); engine.poll(); await engine.drained();
    f.advance(); engine.poll(); await engine.drained(); assert.equal(f.collector.status().activityCount, 1);
    nick = "GM"; f.advance(); engine.poll(); await engine.drained(); assert.equal(f.collector.status().activityCount, 2);
    const b = f.collector.syncBatch(f.grant.grantId, f.collector.pendingSync(f.grant.grantId));
    assert.equal(b.protocol, "personal-coordination/activity-file");
    const envelope = await seal(b, await derive(TRANSFER), "coordination-batch/v1");
    assert.equal((await decodeHandoff(envelope, TRANSFER, "owner", f.now())).events.length, 2);
    await f.collector.markSynced(f.grant.grantId, b.events.map(e => e.eventId), "delivered"); assert.equal(f.collector.pendingSync(f.grant.grantId).length, 0);
    await assert.rejects(f.collector.captureActivity(f.grant.grantId, f.grant.accountId, { type: "member.snapshot", guildId: "55", userId: "99", nickname: nick, displayName: null, roles: [] }));
    f.live.stop();
});
