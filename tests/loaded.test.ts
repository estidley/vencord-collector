import test from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../src/core/collector";
import { LiveCapture } from "../src/core/live";
import { decodeBatch } from "../src/core/connector";
import { MemoryStorage, NOW, PASSWORD, TRANSFER, provenance } from "./fixtures";

test("loaded capture is explicit, bounded, scoped and labeled snapshot; repeats and deletes do not resurrect content", async () => {
    const collector = new Collector(new MemoryStorage(), () => NOW); await collector.unlock(PASSWORD);
    let selected = provenance.channelId, reads = 0;
    const message = { id: "300", channel_id: selected, author: { id: "100000000000000001" }, timestamp: new Date(NOW - 86400_000), editedTimestamp: new Date(NOW - 1000), content: "cached text" };
    let loaded: unknown[] = [message, { ...message, id: "301", flags: 64 }, { ...message, id: "302", deleted: true }];
    const live = new LiveCapture(collector, { accountId: () => "100000000000000001", selectedChannelId: () => selected,
        provenance: () => provenance, loadedMessages: () => { reads++; return loaded; } }, () => NOW);
    assert.throws(() => live.loadedPreview()); assert.equal(reads, 0);
    const grant = await collector.grant({ ...live.allDraft(), allowExport: true }, true); await live.start(grant.grantId, true, true);
    const preview = live.loadedPreview(); assert.equal(preview.events.length, 1);
    await assert.rejects(live.captureLoaded(preview, false)); assert.equal(collector.status().count, 0);
    selected = "999"; await assert.rejects(live.captureLoaded(preview, true)); selected = provenance.channelId;
    await live.captureLoaded(preview, true); await live.captureLoaded(live.loadedPreview(), true); assert.equal(collector.status().count, 1);
    let batch = await decodeBatch(await collector.export(grant.grantId, TRANSFER, true), TRANSFER, "owner", NOW);
    assert.equal(batch.events[0]?.type, "message.snapshot"); assert.equal(batch.events[0]?.provenanceEvidence, "client-observed");
    live.receive("MESSAGE_UPDATE", { message: { id: "300", channel_id: selected, content: "newer live edit" } }); await live.drained();
    await live.captureLoaded(live.loadedPreview(), true);
    batch = await decodeBatch(await collector.export(grant.grantId, TRANSFER, true), TRANSFER, "owner", NOW);
    assert.equal(batch.events[0]?.type, "message.update");
    assert.equal(batch.events[0]?.type === "message.update" && batch.events[0].patch.content, "newer live edit");
    live.receive("MESSAGE_DELETE", { channelId: selected, id: "300" }); await live.drained();
    await live.captureLoaded(live.loadedPreview(), true);
    batch = await decodeBatch(await collector.export(grant.grantId, TRANSFER, true), TRANSFER, "owner", NOW);
    assert.equal(batch.events[0]?.type, "message.delete");
    loaded = Array(1001).fill(message); assert.throws(() => live.loadedPreview(), /1,000/);
    loaded = Array(110).fill({ ...message, content: "x".repeat(20_000) }); assert.throws(() => live.loadedPreview(), /2 MiB/); live.stop();
});
