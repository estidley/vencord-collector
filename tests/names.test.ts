import test from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../src/core/collector";
import { channelProvenance, LiveCapture, userDisplayName } from "../src/core/live";
import { decodeBatch } from "../src/core/connector";
import { derive, open } from "../src/core/crypto";
import { eventSchema, type State } from "../src/core/schema";
import { MemoryStorage, NOW, PASSWORD, TRANSFER, provenance } from "./fixtures";

const ACCOUNT = "100000000000000001", FRIEND = "100000000000000002", CHANNEL = provenance.channelId;
const dm = { ...provenance, participantIds: [ACCOUNT, FRIEND] };

test("display names come from the client's own fields, never invented", () => {
    assert.equal(userDisplayName({ id: "1", username: "smeathen_2", globalName: "Smeathen 2" }), "Smeathen 2");
    assert.equal(userDisplayName({ id: "1", username: "smeathen_2", global_name: "Smeathen 2" }), "Smeathen 2");
    assert.equal(userDisplayName({ id: "1", username: "smeathen_2", globalName: null }), "smeathen_2");
    assert.equal(userDisplayName({ id: "1", username: "  " }), undefined);
    assert.equal(userDisplayName({ id: "1" }), undefined); assert.equal(userDisplayName(undefined), undefined);
    assert.equal(userDisplayName({ globalName: "x".repeat(300) })!.length, 100);
});

test("DMs are labelled with the other people's names; named channels keep their own name", () => {
    const names: Record<string, string> = { [FRIEND]: "Smeathen 2", "100000000000000003": "Heath" };
    const nameOf = (id: string) => names[id];
    assert.equal(channelProvenance({ id: CHANNEL, type: 1, recipients: [FRIEND] }, ACCOUNT, null, nameOf)!.channelName, "Smeathen 2");
    assert.equal(channelProvenance({ id: CHANNEL, type: 3, recipients: [FRIEND, "100000000000000003"] }, ACCOUNT, null, nameOf)!.channelName, "Smeathen 2, Heath");
    assert.equal(channelProvenance({ id: CHANNEL, type: 3, name: "D&D crew", recipients: [FRIEND] }, ACCOUNT, null, nameOf)!.channelName, "D&D crew");
    assert.equal(channelProvenance({ id: CHANNEL, type: 1, recipients: [FRIEND] }, ACCOUNT)!.channelName, null, "unknown name stays null");
    const guild = channelProvenance({ id: "600000000000000001", type: 0, guild_id: "500000000000000001", name: "game-night" }, ACCOUNT, "Brewzle", nameOf)!;
    assert.equal(guild.channelName, "game-night"); assert.equal(guild.guildName, "Brewzle");
});

test("live capture keeps the sender's display name through edits and exports it; deletes carry none", async () => {
    const store = new MemoryStorage(), c = new Collector(store, () => NOW);
    const live = new LiveCapture(c, { accountId: () => ACCOUNT, selectedChannelId: () => CHANNEL, provenance: () => dm,
        loadedMessages: () => [{ id: "300000000000000009", channel_id: CHANNEL, author: { id: FRIEND, username: "smeathen_2", globalName: "Smeathen 2" },
            timestamp: new Date(NOW - 60_000), editedTimestamp: null, content: "loaded text" }] }, () => NOW);
    await c.unlock(PASSWORD);
    const g = await c.grant({ ...live.allDraft(), allowExport: true }, true); await live.start(g.grantId, true, true);
    live.receive("MESSAGE_CREATE", { message: { id: "300000000000000001", channel_id: CHANNEL, author: { id: FRIEND, username: "smeathen_2", global_name: "Smeathen 2" },
        timestamp: new Date(NOW).toISOString(), content: "see you Tuesday" } });
    live.receive("MESSAGE_CREATE", { message: { id: "300000000000000002", channel_id: CHANNEL, author: { id: ACCOUNT }, timestamp: new Date(NOW).toISOString(), content: "no name known" } });
    await live.drained();
    live.receive("MESSAGE_UPDATE", { message: { id: "300000000000000001", channel_id: CHANNEL, content: "see you Wednesday" } }); await live.drained();
    await live.captureLoaded(live.loadedPreview(), true);
    const batch = await decodeBatch(await c.export(g.grantId, TRANSFER, true), TRANSFER, "owner", NOW);
    const byId = Object.fromEntries(batch.events.map(e => [e.messageId, e]));
    assert.equal(byId["300000000000000001"]!.type, "message.update"); assert.equal(byId["300000000000000001"]!.senderName, "Smeathen 2", "edit keeps the name");
    assert.equal(byId["300000000000000002"]!.senderName, undefined, "no name invented");
    assert.equal(byId["300000000000000009"]!.senderName, "Smeathen 2", "loaded snapshot names from the client User record");
    live.receive("MESSAGE_DELETE", { channelId: CHANNEL, id: "300000000000000001" }); await live.drained();
    const state = await open(store.value!.envelope, await derive(PASSWORD, store.value!.envelope.salt), "collector-vault/v1") as State;
    const del = state.records.find(r => r.event.messageId === "300000000000000001")!.event;
    assert.equal(del.type, "message.delete"); assert.equal(del.senderName, undefined);
    assert.ok(!JSON.stringify(store.value).includes("Smeathen"), "names are encrypted at rest like everything else");
    live.stop();
});

test("events without a name (older exports and files) stay valid; empty names are rejected", () => {
    const base = { version: 1, type: "message.delete", eventId: crypto.randomUUID(), messageId: "1", source: "vencord-live", accountId: ACCOUNT,
        provenance: dm, provenanceEvidence: "client-observed", grantId: crypto.randomUUID(), observedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 1000).toISOString(), sourceTimestamp: null, senderId: FRIEND };
    assert.ok(eventSchema.safeParse(base).success);
    assert.ok(!eventSchema.safeParse({ ...base, senderName: "  " }).success);
    assert.ok(!eventSchema.safeParse({ ...base, senderName: "x".repeat(101) }).success);
});
