// SPDX-License-Identifier: GPL-3.0-or-later
import definePlugin from "@utils/types";
import { ChannelStore, GuildStore, React, SelectedChannelStore, UserStore } from "@webpack/common";
import { Collector } from "../core/collector";
import { channelProvenance, LiveCapture } from "../core/live";
import { IndexedDbStorage } from "../core/storage";
import { createPanel } from "../ui/Panel";

const collector = new Collector(new IndexedDbStorage());
collector.suspend();
const live = new LiveCapture(collector, {
    accountId: () => UserStore.getCurrentUser()?.id,
    selectedChannelId: () => SelectedChannelStore.getChannelId(),
    provenance: channelId => {
        const accountId = UserStore.getCurrentUser()?.id;
        const channel = ChannelStore.getChannel(channelId);
        if (!accountId || !channel) return undefined;
        const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined;
        return channelProvenance(channel, accountId, guild?.name ?? null);
    }
});
let Panel: ReturnType<typeof createPanel> | undefined;

function SettingsPanel() {
    // Vencord's React export is resolved after plugin modules load. Read it only at render time.
    Panel ??= createPanel(React, collector, live);
    return <Panel />;
}

export default definePlugin({
    name: "MessageCollector",
    description: "Opt-in live capture of selected conversations, file imports, and encrypted local buffering.",
    authors: [], // Private plugin: no invented Discord author ID.
    enabledByDefault: false,
    settingsAboutComponent: SettingsPanel,
    start() { collector.resume(); globalThis.addEventListener?.("pagehide", stopSession); },
    stop() { globalThis.removeEventListener?.("pagehide", stopSession); live.stop(); collector.suspend(); },
    flux: {
        MESSAGE_CREATE: payload => live.receive("MESSAGE_CREATE", payload),
        MESSAGE_UPDATE: payload => live.receive("MESSAGE_UPDATE", payload),
        MESSAGE_DELETE: payload => live.receive("MESSAGE_DELETE", payload),
        MESSAGE_DELETE_BULK: payload => live.receive("MESSAGE_DELETE_BULK", payload),
        LOGOUT: () => live.stop("Logged out. Capture stopped and buffer locked."),
        CONNECTION_OPEN: () => live.checkAccount(),
        CURRENT_USER_UPDATE: () => live.checkAccount()
    }
});

function stopSession() { live.stop(); }
