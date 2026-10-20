// SPDX-License-Identifier: GPL-3.0-or-later
import definePlugin from "@utils/types";
import { ChannelStore, GuildStore, React, SelectedChannelStore, UserStore } from "@webpack/common";
import { Collector } from "../core/collector";
import { channelProvenance, LiveCapture } from "../core/live";
import { IndexedDbStorage } from "../core/storage";
import { AlwaysOn } from "../core/always-on";
import type { AutoProtection } from "../core/auto-config";
import { createPanel } from "../ui/Panel";

const storage = new IndexedDbStorage();
const collector = new Collector(storage);
collector.suspend();
const live = new LiveCapture(collector, {
    accountId: () => UserStore?.getCurrentUser()?.id,
    selectedChannelId: () => SelectedChannelStore.getChannelId(),
    provenance: channelId => {
        const accountId = UserStore.getCurrentUser()?.id;
        const channel = ChannelStore.getChannel(channelId);
        if (!accountId || !channel) return undefined;
        const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined;
        return channelProvenance(channel, accountId, guild?.name ?? null);
    }
});
const currentAccount = () => UserStore?.getCurrentUser()?.id;
const always = new AlwaysOn(collector, live, storage,
    () => typeof VencordNative !== "undefined" ? VencordNative.pluginHelpers?.MessageCollector as unknown as AutoProtection | undefined : undefined,
    currentAccount);
let watcher: ReturnType<typeof setInterval> | undefined;
let observedAccount: string | undefined;
function ready() {
    const account = currentAccount();
    if (observedAccount && account !== observedAccount) always.accountChanged();
    observedAccount = account; live.checkAccount(); void always.restore();
}
let Panel: ReturnType<typeof createPanel> | undefined;

function SettingsPanel() {
    // Vencord's React export is resolved after plugin modules load. Read it only at render time.
    Panel ??= createPanel(React, collector, live, always);
    return <Panel />;
}

export default definePlugin({
    name: "MessageCollector",
    description: "Opt-in live capture of selected conversations, file imports, and encrypted local buffering.",
    authors: [], // Private plugin: no invented Discord author ID.
    enabledByDefault: false,
    settingsAboutComponent: SettingsPanel,
    start() {
        collector.resume(); always.activate(); observedAccount = undefined; ready();
        watcher = setInterval(ready, 1000); if (typeof watcher === "object") watcher.unref?.();
        globalThis.addEventListener?.("pagehide", stopSession);
    },
    stop() {
        globalThis.removeEventListener?.("pagehide", stopSession); clearInterval(watcher);
        void always.disable().catch(() => {}); always.shutdown(); collector.suspend();
    },
    flux: {
        MESSAGE_CREATE: payload => live.receive("MESSAGE_CREATE", payload),
        MESSAGE_UPDATE: payload => live.receive("MESSAGE_UPDATE", payload),
        MESSAGE_DELETE: payload => live.receive("MESSAGE_DELETE", payload),
        MESSAGE_DELETE_BULK: payload => live.receive("MESSAGE_DELETE_BULK", payload),
        LOGOUT: () => { observedAccount = undefined; always.accountChanged(); },
        CONNECTION_OPEN: ready,
        CURRENT_USER_UPDATE: ready
    }
});

function stopSession() { clearInterval(watcher); always.shutdown(); }
