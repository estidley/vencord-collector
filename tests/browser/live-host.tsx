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
let account = "100000000000000001"; const channel = "200000000000000001";
const storage = new IndexedDbStorage(); const collector = new Collector(storage);
const live = new LiveCapture(collector, {
    accountId: () => account, selectedChannelId: () => channel,
    provenance: () => ({ kind: "dm", guildId: null, guildName: null, channelId: channel,
        channelName: null, parentChannelId: null, threadId: null, participantIds: [account] })
});
// Fake OS protection for synthetic browser tests only. Production uses Windows DPAPI.
const testKeyPassword = "synthetic operating system fixture key";
const always = new URLSearchParams(location.search).has("always") ? new AlwaysOn(collector, live, storage, () => ({
    available: async () => true,
    protect: async config => btoa(JSON.stringify(await seal(config, await derive(testKeyPassword), "coordination-batch/v1"))),
    restore: async (cipher, currentAccount) => { const envelope = JSON.parse(atob(cipher));
        const config = autoConfigSchema.parse(await open(envelope, await derive(testKeyPassword, envelope.salt), "coordination-batch/v1"));
        return config.accountId === currentAccount ? config : undefined; }
}), () => account) : undefined;
always?.activate(); void always?.restore();
window.addEventListener("pagehide", () => always?.shutdown());
const Panel = createPanel(React, collector, live, always);
const root = createRoot(document.getElementById("root")!);
const fixture = {
    mount: (visible: boolean) => root.render(visible ? <Panel /> : <p>Test settings closed</p>),
    emit: async () => {
        live.receive("MESSAGE_CREATE", { message: { id: "300000000000000002", channel_id: channel,
            author: { id: account }, timestamp: new Date().toISOString(), content: "synthetic browser live text" } });
        await live.drained();
    },
    status: () => ({ ...live.status(), count: collector.status().count, unlocked: collector.unlocked }),
    switchAccount: async (value: string) => { account = value; always?.accountChanged(); await always?.restore(); },
    storedAuto: () => storage.readAuto()
};
(window as any).__liveFixture = fixture;
fixture.mount(true);
