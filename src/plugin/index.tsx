// SPDX-License-Identifier: GPL-3.0-or-later
import definePlugin from "@utils/types";
import { ChannelStore, GuildStore, GuildScheduledEventStore, MessageStore, PresenceStore, VoiceStateStore, React, SelectedChannelStore, UserStore } from "@webpack/common";
import { ActivityCapture } from "../core/activity";
import { Collector } from "../core/collector";
import { channelProvenance, LiveCapture } from "../core/live";
import { IndexedDbStorage } from "../core/storage";
import { AlwaysOn } from "../core/always-on";
import type { AutoProtection } from "../core/auto-config";
import { SyncController } from "../core/sync";
import type { SyncNative } from "../core/sync-config";
import { createPanel } from "../ui/Panel";

const storage = new IndexedDbStorage();
const collector = new Collector(storage);
collector.suspend();
const live = new LiveCapture(collector, {
    accountId: () => UserStore?.getCurrentUser()?.id,
    selectedChannelId: () => SelectedChannelStore.getChannelId(),
    loadedMessages: channelId => MessageStore.getMessages(channelId)?._array ?? [],
    provenance: channelId => {
        const accountId = UserStore.getCurrentUser()?.id;
        const channel = ChannelStore.getChannel(channelId);
        if (!accountId || !channel) return undefined;
        const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined;
        return channelProvenance(channel, accountId, guild?.name ?? null);
    }
});
const currentAccount = () => UserStore?.getCurrentUser()?.id;
const activity = new ActivityCapture(collector, live, {
    accountId: currentAccount,
    scheduledEvents: guildId => GuildScheduledEventStore?.getGuildScheduledEventsForGuild(guildId),
    presence: userId => PresenceStore?.getState()?.statuses?.[userId],
    voice: (guildId, userId) => VoiceStateStore?.getVoiceState(guildId, userId)?.channelId,
    guildForChannel: channelId => ChannelStore?.getChannel(channelId)?.guild_id
});
const nativeHelper = () => typeof VencordNative !== "undefined" ? VencordNative.pluginHelpers?.MessageCollector as unknown as (AutoProtection & SyncNative) | undefined : undefined;
// Receiver sync is off unless explicitly armed during always-on setup; the token stays inside the native helper.
const sync: SyncController = new SyncController(collector, storage, nativeHelper, currentAccount, () => always.grantId);
const always = new AlwaysOn(collector, live, storage, nativeHelper, currentAccount, sync);
let watcher: ReturnType<typeof setInterval> | undefined;
let observedAccount: string | undefined;
function ready() {
    const account = currentAccount();
    if (observedAccount && account !== observedAccount) always.accountChanged();
    observedAccount = account; live.checkAccount(); void always.restore(); activity.poll(); void sync.tick();
}
let Panel: ReturnType<typeof createPanel> | undefined;

function SettingsPanel() {
    // Vencord's React export is resolved after plugin modules load. Read it only at render time.
    Panel ??= createPanel(React, collector, live, always, sync);
    return <Panel />;
}

// Stable plugin/native-helper identity preserves installed settings and automatic unlock.
export default definePlugin({
    name: "MessageCollector",
    description: "Vencord Collector: messages, loaded snapshots, scheduled events, and opt-in presence/voice observations.",
    authors: [], // Private plugin: no invented Discord author ID.
    enabledByDefault: false,
    settingsAboutComponent: SettingsPanel,
    start() {
        collector.resume(); activity.connection(true); always.activate(); observedAccount = undefined; ready();
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
        VOICE_STATE_UPDATES: payload => activity.voiceUpdates(payload),
        LOGOUT: () => { observedAccount = undefined; always.accountChanged(); },
        CONNECTION_OPEN: () => { activity.connection(true); ready(); },
        CONNECTION_RESUMED: () => { activity.connection(true); ready(); },
        CONNECTION_INTERRUPTED: () => activity.connection(false),
        CONNECTION_CLOSED: () => activity.connection(false),
        CURRENT_USER_UPDATE: ready
    }
});

function stopSession() { clearInterval(watcher); always.shutdown(); }
