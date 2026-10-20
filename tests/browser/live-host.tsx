// Synthetic host used only by the test server. Never included in production builds.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Collector } from "../../src/core/collector";
import { LiveCapture } from "../../src/core/live";
import { IndexedDbStorage } from "../../src/core/storage";
import { createPanel } from "../../src/ui/Panel";
const account = "100000000000000001", channel = "200000000000000001";
const collector = new Collector(new IndexedDbStorage());
const live = new LiveCapture(collector, {
    accountId: () => account, selectedChannelId: () => channel,
    provenance: () => ({ kind: "dm", guildId: null, guildName: null, channelId: channel,
        channelName: null, parentChannelId: null, threadId: null, participantIds: [account] })
});
const Panel = createPanel(React, collector, live);
const root = createRoot(document.getElementById("root")!);
const fixture = {
    mount: (visible: boolean) => root.render(visible ? <Panel /> : <p>Test settings closed</p>),
    emit: async () => {
        live.receive("MESSAGE_CREATE", { message: { id: "300000000000000002", channel_id: channel,
            author: { id: account }, timestamp: new Date().toISOString(), content: "synthetic browser live text" } });
        await live.drained();
    },
    status: () => ({ ...live.status(), count: collector.status().count, unlocked: collector.unlocked })
};
(window as any).__liveFixture = fixture;
fixture.mount(true);
