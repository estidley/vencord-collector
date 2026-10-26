// Synthetic host used only by the test server. Never included in production builds.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Collector } from "../../src/core/collector";
import { LiveCapture } from "../../src/core/live";
import { IndexedDbStorage } from "../../src/core/storage";
import { createPanel } from "../../src/ui/Panel";
import { AlwaysOn } from "../../src/core/always-on";
import { autoConfigSchema } from "../../src/core/auto-config";
import { derive, seal, open } from "../../src/core/crypto";
import { ActivityCapture } from "../../src/core/activity";
import { SyncController } from "../../src/core/sync";
import type { SyncNative } from "../../src/core/sync-config";
let account = "100000000000000001"; const channel = "200000000000000001";
const storage = new IndexedDbStorage(); const collector = new Collector(storage);
const live = new LiveCapture(collector, {
    cachedGuildIds: () => ["500", "501"],
    accountId: () => account, selectedChannelId: () => channel,
    loadedMessages: () => [{ id: "300000000000000003", channel_id: channel, author: { id: account }, timestamp: new Date().toISOString(), content: "synthetic cached text" }],
    provenance: () => ({ kind: "dm", guildId: null, guildName: null, channelId: channel,
        channelName: null, parentChannelId: null, threadId: null, participantIds: [account] })
});
const activity = new ActivityCapture(collector, live, {
    accountId: () => account,
    scheduledEvents: guildId => [{ id: "400", guild_id: guildId, name: "Synthetic game night", scheduled_start_time: "2026-12-01T19:00:00Z", status: 1 }],
    person: userId => ({ type: "person.snapshot", userId, personalNickname: "My friend", displayName: "<img src=x onerror=alert(1)>", username: "account_name" }),
    presence: () => "online", voice: () => undefined
});
// Fake OS protection for synthetic browser tests only. Production uses Windows DPAPI.
const testKeyPassword = "synthetic operating system fixture key";
// Fake native sync boundary + receiver (no network; CSP connect-src 'none'). The real path is covered by native tests and e2e.
const received: string[] = []; let receiverToken = "";
const syncNative: SyncNative = {
    available: async () => true,
    protectSync: async setup => { receiverToken = setup.token; return btoa(JSON.stringify({ grantId: setup.grantId })); },
    probeSync: async () => receiverToken === "R".repeat(43) ? { ok: true, checkpoint: 0 } : { ok: false, kind: "credentials", status: 401 },
    deliver: async (_blob, _account, batch: any) => { received.push(...batch.events.map((e: any) => e.eventId));
        return { ok: true, receipt: { version: 1, receiptId: crypto.randomUUID(), checkpoint: received.length, accepted: batch.events.length, duplicates: 0, committedAt: new Date().toISOString() } }; }
};
let alwaysRef: AlwaysOn | undefined;
const sync = new URLSearchParams(location.search).has("sync") ? new SyncController(collector, storage, () => syncNative, () => account, () => alwaysRef?.grantId) : undefined;
const always = new URLSearchParams(location.search).has("always") ? new AlwaysOn(collector, live, storage, () => ({
    available: async () => true,
    protect: async config => btoa(JSON.stringify(await seal(config, await derive(testKeyPassword), "coordination-batch/v1"))),
    restore: async (cipher, currentAccount) => { const envelope = JSON.parse(atob(cipher));
        const config = autoConfigSchema.parse(await open(envelope, await derive(testKeyPassword, envelope.salt), "coordination-batch/v1"));
        return config.accountId === currentAccount ? config : undefined; }
}), () => account, sync) : undefined;
alwaysRef = always;
always?.activate(); void always?.restore();
window.addEventListener("pagehide", () => always?.shutdown());
const Panel = createPanel(React, collector, live, always, sync);
const root = createRoot(document.getElementById("root")!);
const fixture = {
    mount: (visible: boolean) => root.render(visible ? <Panel /> : <p>Test settings closed</p>),
    emit: async () => {
        live.receive("MESSAGE_CREATE", { message: { id: "300000000000000002", channel_id: channel,
            author: { id: account }, timestamp: new Date().toISOString(), content: "synthetic browser live text" } });
        await live.drained();
    },
    choices: () => collector.status().grants.find(g => g.grantId === always?.grantId)?.activity,
    status: () => ({ ...live.status(), count: collector.status().count, unlocked: collector.unlocked }),
    switchAccount: async (value: string) => { account = value; always?.accountChanged(); await always?.restore(); },
    storedAuto: () => storage.readAuto(),
    storedSync: () => storage.readSync(),
    received: () => received.length,
    syncTick: () => sync?.syncNow(),
    activity: async () => { activity.poll(); await activity.drained(); return collector.status().activityCount; }
};
(window as any).__liveFixture = fixture;
fixture.mount(true);
