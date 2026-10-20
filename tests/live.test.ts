import test from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../src/core/collector";
import { channelProvenance, LiveCapture } from "../src/core/live";
import { decodeBatch } from "../src/core/connector";
import { derive, open } from "../src/core/crypto";
import { grantDraftSchema, type Provenance, type State } from "../src/core/schema";
import { MemoryStorage, NOW, PASSWORD, TRANSFER, draft, input, provenance } from "./fixtures";

const ACCOUNT = "100000000000000001", OTHER = "100000000000000002", CHANNEL = provenance.channelId;
const create = (overrides = {}) => ({ message: { id: "300000000000000001", channel_id: CHANNEL,
    author: { id: ACCOUNT }, timestamp: new Date(NOW).toISOString(), content: "original live text", ...overrides } });
async function setup(overrides = {}) {
    const store = new MemoryStorage(); let now = NOW;
    const c = new Collector(store, () => now);
    const host = { account: ACCOUNT, scope: { ...provenance, participantIds: [ACCOUNT, OTHER] },
        accountId() { return this.account; }, selectedChannelId: () => CHANNEL,
        provenance(_channelId: string): Provenance | undefined { return this.scope; } };
    const live = new LiveCapture(c, host, () => now);
    await c.unlock(PASSWORD);
    const g = await c.grant({ ...live.currentDraft(), allowExport: true, ...overrides }, true);
    const state = async () => await open(store.value!.envelope, await derive(PASSWORD, store.value!.envelope.salt), "collector-vault/v1") as State;
    return { store, c, g, host, live, state, advance: (ms: number) => { now += ms; } };
}

test("live starts only with confirmation, current account/scope and a live permission", async () => {
    const { c, g, live, host } = await setup();
    live.receive("MESSAGE_CREATE", create()); await live.drained(); assert.equal(c.status().count, 0);
    await assert.rejects(live.start(g.grantId, false), /Confirm/);
    host.account = OTHER; await assert.rejects(live.start(g.grantId, true), /does not match/); host.account = ACCOUNT;
    const manual = await c.grant(draft(), true); await assert.rejects(live.start(manual.grantId, true), /does not match/);
    assert.throws(() => c.preview(input(), g.grantId), /file-import/);
    await live.start(g.grantId, true); assert.equal(live.active, true);
    await assert.rejects(live.start(g.grantId, true), /already live/); live.stop();
});

test("live records both DM senders, excludes other scopes, local echoes and attachments", async () => {
    const { c, g, live, store, state } = await setup(); await live.start(g.grantId, true);
    live.receive("MESSAGE_CREATE", create({ channel_id: "999" }));
    live.receive("MESSAGE_CREATE", create({ author: { id: "999" } }));
    live.receive("MESSAGE_CREATE", { ...create(), optimistic: true });
    live.receive("MESSAGE_CREATE", create({ state: "SENDING" }));
    live.receive("MESSAGE_CREATE", create({ flags: 64 }));
    live.receive("MESSAGE_CREATE", create({ timestamp: new Date(NOW), attachments: [{ url: "https://private.invalid" }] }));
    live.receive("MESSAGE_CREATE", create({ id: "300000000000000002", author: { id: OTHER } }));
    live.receive("MESSAGE_CREATE", create()); await live.drained();
    assert.equal(c.status().count, 2); assert.equal(live.status().saved, 2);
    const s = await state(); assert.deepEqual(s.records.map(r => r.event.senderId), [ACCOUNT, OTHER]);
    assert.ok(!JSON.stringify(s).includes("private.invalid")); assert.ok(!JSON.stringify(store.value).includes("original live text"));
    const b = await decodeBatch(await c.export(g.grantId, TRANSFER, true), TRANSFER, "owner", NOW);
    assert.equal(b.events[0]!.provenanceEvidence, "client-observed"); assert.equal(b.events[0]!.source, "vencord-live"); live.stop();
});

test("partial edits keep latest text, remove old live text and ignore unknown messages", async () => {
    const { c, g, live, state } = await setup(); await live.start(g.grantId, true);
    live.receive("MESSAGE_UPDATE", { message: { id: "999", channel_id: CHANNEL, content: "unknown" } });
    live.receive("MESSAGE_CREATE", create());
    live.receive("MESSAGE_UPDATE", { message: { id: "300000000000000001", channel_id: CHANNEL, content: "replacement text" } });
    live.receive("MESSAGE_UPDATE", { message: { id: "300000000000000001", channel_id: CHANNEL, edited_timestamp: new Date(NOW + 1000).toISOString() } });
    await live.drained(); const s = await state();
    assert.equal(s.records.length, 1); assert.ok(!JSON.stringify(s).includes("original live text"));
    const b = await decodeBatch(await c.export(g.grantId, TRANSFER, true), TRANSFER, "owner", NOW);
    const e = b.events[0]!; assert.equal(e.type, "message.update");
    if (e.type === "message.update") { assert.equal(e.patch.content, "replacement text"); assert.equal(e.patch.editedAt, new Date(NOW + 1000).toISOString()); }
    live.stop();
});

test("observed deletion purges imported copies too and blocks stale reimport/replay", async () => {
    const { c, g, live, state } = await setup();
    const manual = await c.grant(draft({ allowExport: true }), true); await c.import(input(), manual.grantId, true);
    await live.start(g.grantId, true);
    // This client never observed the original create; the import supplies known sender identity.
    live.receive("MESSAGE_DELETE", { channelId: CHANNEL, id: "300000000000000001" }); await live.drained();
    live.receive("MESSAGE_CREATE", create()); await live.drained();
    assert.equal(await c.import(input(), manual.grantId, true), 0);
    const s = await state(); assert.equal(s.records.length, 1); assert.equal(s.records[0]!.event.type, "message.delete");
    assert.ok(!JSON.stringify(s).includes("private canary")); assert.ok(!JSON.stringify(s).includes("original live text"));
    const b = await decodeBatch(await c.export(g.grantId, TRANSFER, true), TRANSFER, "owner", NOW);
    assert.equal(b.events[0]!.sourceTimestamp, null); assert.ok(!("content" in b.events[0]!)); live.stop();
});

test("bulk deletions produce content-free tombstones only for known permitted senders", async () => {
    const { g, live, state } = await setup(); await live.start(g.grantId, true);
    live.receive("MESSAGE_CREATE", create()); live.receive("MESSAGE_CREATE", create({ id: "300000000000000002" }));
    live.receive("MESSAGE_DELETE_BULK", { channelId: CHANNEL, ids: ["300000000000000001", "300000000000000002", "999"] });
    await live.drained(); const s = await state(); assert.equal(s.records.length, 2);
    assert.ok(s.records.every(r => r.event.type === "message.delete")); live.stop();
});

test("account switching cancels queued capture and drops keys", async () => {
    const { c, g, live, host, state } = await setup(); await live.start(g.grantId, true);
    live.receive("MESSAGE_CREATE", create()); host.account = OTHER; live.checkAccount(); await live.drained();
    assert.equal(c.unlocked, false); assert.equal(live.active, false); assert.equal((await state()).records.length, 0);
});

test("membership changes stop capture before saving the event", async () => {
    const { c, g, live, host, state } = await setup(); await live.start(g.grantId, true);
    host.scope.participantIds.push("999"); live.receive("MESSAGE_CREATE", create()); await live.drained();
    assert.equal(c.unlocked, false); assert.match(live.status().notice, /membership/); assert.equal((await state()).records.length, 0);
});

test("revocation stops the last live scope; unlock does not restart it", async () => {
    const { c, g, live } = await setup(); await live.start(g.grantId, true);
    live.receive("MESSAGE_CREATE", create()); await live.drained(); await c.revoke(g.grantId);
    assert.equal(live.active, false); assert.equal(c.unlocked, false); await c.unlock(PASSWORD);
    live.receive("MESSAGE_CREATE", create()); await live.drained(); assert.equal(c.status().count, 0); live.stop();
});

test("one-hour boundary and earlier permission expiry stop capture", async () => {
    for (const duration of [60 * 60_000, 60_000]) {
        const { c, g, live, advance, state } = await setup({ expiresAt: new Date(NOW + duration).toISOString() });
        await live.start(g.grantId, true); advance(duration); live.receive("MESSAGE_CREATE", create()); await live.drained();
        assert.equal(c.unlocked, false); assert.equal((await state()).records.length, 0);
    }
});

test("storage failure stops live capture without claiming success", async () => {
    const { c, g, live, store, state } = await setup(); await live.start(g.grantId, true); store.fail = true;
    live.receive("MESSAGE_CREATE", create()); await live.drained();
    assert.equal(c.unlocked, false); assert.equal(live.status().saved, 0); assert.equal((await state()).records.length, 0);
    assert.match(live.status().notice, /could not save/);
});

test("bounded queue stops capture instead of silently dropping events", async () => {
    const { c, g, live } = await setup(); await live.start(g.grantId, true);
    for (let i = 0; i < 120; i++) live.receive("MESSAGE_CREATE", create({ id: String(i + 1), content: "x".repeat(20_000) }));
    await live.drained(); assert.equal(c.unlocked, false); assert.equal(live.active, false);
    assert.match(live.status().notice, /queue filled|could not save/);
});

test("file imports and live observations serialize without losing either", async () => {
    const { c, g, live } = await setup(); const manual = await c.grant(draft(), true); await live.start(g.grantId, true);
    const importing = c.import(input(), manual.grantId, true);
    live.receive("MESSAGE_CREATE", create({ id: "300000000000000002" }));
    await importing; await live.drained(); assert.equal(c.status().count, 2); live.stop();
});

test("provenance maps guild channels, threads, DMs and group DMs without guessed IDs", () => {
    const channel = { id: CHANNEL, type: 1, recipients: [OTHER] };
    assert.deepEqual(channelProvenance(channel, ACCOUNT)?.participantIds, [ACCOUNT, OTHER]);
    assert.equal(channelProvenance({ ...channel, type: 3 }, ACCOUNT)?.kind, "group-dm");
    const guild = { id: CHANNEL, type: 0, guild_id: "123", name: "selected channel" };
    assert.equal(channelProvenance(guild, ACCOUNT, "server")?.guildId, "123");
    assert.equal(channelProvenance({ ...guild, type: 11, parent_id: "456" }, ACCOUNT)?.threadId, CHANNEL);
    assert.equal(channelProvenance({ ...guild, type: 11 }, ACCOUNT), undefined);
    assert.equal(channelProvenance({ ...guild, type: 2 }, ACCOUNT)?.kind, "guild-channel");
    assert.equal(channelProvenance({ ...guild, type: 13 }, ACCOUNT)?.kind, "guild-channel");
    assert.equal(channelProvenance({ ...guild, type: 4 }, ACCOUNT), undefined);
});

test("all-conversations capture requires its own risk confirmation and cannot mix with selected sessions", async () => {
    const { c, g, live } = await setup(); const all = await c.grant(live.allDraft(), true);
    await assert.rejects(live.start(all.grantId, true), /risk/); assert.equal(live.active, false);
    await live.start(g.grantId, true); await assert.rejects(live.start(all.grantId, true, true), /Stop/); live.stop();
    await c.unlock(PASSWORD); await live.start(all.grantId, true, true);
    await assert.rejects(live.start(g.grantId, true), /Stop/);
    assert.equal(live.status().allConversations, true); live.stop();
    await c.unlock(PASSWORD); live.receive("MESSAGE_CREATE", create()); await live.drained();
    assert.equal(c.status().count, 0); assert.equal(live.status().allConversations, false);
});

test("account scope covers newly observed DMs, servers, channels and threads with per-event provenance", async () => {
    const { c, live, host, state } = await setup();
    const all = await c.grant({ ...live.allDraft(), allowExport: true }, true);
    await live.start(all.grantId, true, true);
    const scopes = new Map<string, Provenance>(); host.provenance = channelId => scopes.get(channelId);
    for (const [channelId, type, guild_id, parent_id] of [["1", 1, undefined, undefined], ["2", 3, undefined, undefined],
        ["3", 0, "100", undefined], ["4", 5, "200", undefined], ["5", 11, "200", "4"]] as const) {
        scopes.set(channelId, channelProvenance({ id: channelId, type, guild_id, parent_id, recipients: [OTHER] }, ACCOUNT)!);
        live.receive("MESSAGE_CREATE", create({ channel_id: channelId, author: { id: OTHER } }));
    }
    live.receive("MESSAGE_CREATE", create({ channel_id: "999" })); // No attributable metadata, no copy.
    await live.drained(); const s = await state(); assert.equal(s.records.length, 5);
    assert.deepEqual(s.records.map(r => r.event.provenance.kind), ["dm", "group-dm", "guild-channel", "guild-channel", "guild-thread"]);
    assert.ok(s.records.every(r => r.event.senderId === OTHER));
    const b = await decodeBatch(await c.export(all.grantId, TRANSFER, true), TRANSFER, "owner", NOW);
    assert.equal(b.grant.scope, "account"); assert.equal(b.grant.provenance, null); assert.equal(b.events.length, 5);
    // Updates remain in the matching channel even if message IDs happen to coincide in the fixture.
    live.receive("MESSAGE_UPDATE", { message: { id: "300000000000000001", channel_id: "5", content: "edited thread" } });
    await live.drained(); scopes.delete("5");
    live.receive("MESSAGE_DELETE", { id: "300000000000000001", channelId: "5" }); await live.drained();
    const deleted = (await state()).records.filter(r => r.event.type === "message.delete");
    assert.equal(deleted.length, 1); assert.equal(deleted[0]!.event.provenance.threadId, "5"); live.stop();
});

test("account-wide scope is live-only and cannot disguise a sender allowlist or imported provenance", () => {
    const all = { ...draft(), source: "vencord-live", scope: "account", provenance: null, allowedSenderIds: [] };
    assert.ok(grantDraftSchema.safeParse(all).success);
    for (const changed of [{ source: "manual" }, { source: "discord-data-package" }, { provenance }, { allowedSenderIds: [ACCOUNT] }])
        assert.ok(!grantDraftSchema.safeParse({ ...all, ...changed }).success);
    assert.ok(!grantDraftSchema.safeParse({ ...draft(), allowedSenderIds: [] }).success);
});

test("account-wide capture is still bound to the signed-in account and actual DM membership", async () => {
    const { c, live, host } = await setup(); const all = await c.grant(live.allDraft(), true);
    await live.start(all.grantId, true, true);
    await assert.rejects(c.captureLive(all.grantId, OTHER, { type: "create", channelId: CHANNEL,
        messageId: "1", senderId: OTHER, content: "wrong account", createdAt: new Date(NOW).toISOString() }, host.scope), /outside/);
    host.scope.participantIds = [OTHER]; live.receive("MESSAGE_CREATE", create()); await live.drained();
    assert.equal(c.unlocked, false); assert.equal(live.active, false);
});
