// SPDX-License-Identifier: GPL-3.0-or-later
import definePlugin from "@utils/types";
import { ChannelStore, GuildStore, GuildMemberStore, GuildRoleStore, ReadStateStore, RelationshipStore, PermissionStore, PermissionsBits, GuildScheduledEventStore, MessageStore, PresenceStore, VoiceStateStore, React, SelectedChannelStore, UserStore } from "@webpack/common";
import { ActivityCapture } from "../core/activity";
import { Collector } from "../core/collector";
import { channelProvenance, LiveCapture, userDisplayName } from "../core/live";
import { IndexedDbStorage } from "../core/storage";
import { AlwaysOn } from "../core/always-on";
import type { AutoProtection } from "../core/auto-config";
import { SyncController } from "../core/sync";
import type { SyncNative } from "../core/sync-config";
import { createPanel } from "../ui/Panel";

function visibleChannel(channelId: string) {
    const c = ChannelStore?.getChannel(channelId);
    if (!c || (c.guild_id && !PermissionStore?.can(PermissionsBits.VIEW_CHANNEL, c))) return;
    return c;
}
const storage = new IndexedDbStorage();
const collector = new Collector(storage);
collector.suspend();
const live = new LiveCapture(collector, {
    accountId: () => UserStore?.getCurrentUser()?.id,
    selectedChannelId: () => SelectedChannelStore.getChannelId(),
    cachedMessage: (channelId, messageId) => MessageStore.getMessage(channelId, messageId),
    loadedMessages: channelId => MessageStore.getMessages(channelId)?._array ?? [],
    cachedGuildIds: () => Object.keys(GuildStore?.getGuilds() ?? {}),
    provenance: channelId => {
        const accountId = UserStore.getCurrentUser()?.id;
        const channel = visibleChannel(channelId);
        if (!accountId || !channel) return undefined;
        const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined;
        return channelProvenance(channel, accountId, guild?.name ?? null, id => userDisplayName(UserStore.getUser(id)));
    }
});
const currentAccount = () => UserStore?.getCurrentUser()?.id;
const activity = new ActivityCapture(collector, live, {
    accountId: currentAccount,
    scheduledEvents: guildId => GuildScheduledEventStore?.getGuildScheduledEventsForGuild(guildId),
    presence: userId => PresenceStore?.getState()?.statuses?.[userId],
    voice: (guildId, userId) => VoiceStateStore?.getVoiceState(guildId, userId)?.channelId,
    person: userId => {
        const user = UserStore?.getUser(userId); if (!user) return;
        return { type: "person.snapshot", userId, personalNickname: RelationshipStore?.getNickname(userId) ?? null,
            displayName: user.globalName ?? null, username: user.username ?? null };
    },
    member: (guildId, userId) => {
        if (!GuildStore?.getGuild(guildId)) return;
        const member = GuildMemberStore?.getMember(guildId, userId);
        if (!member || !Array.isArray(member.roles)) return;
        return { type: "member.snapshot", guildId, userId, displayName: UserStore.getUser(userId)?.globalName ?? null,
            personalNickname: RelationshipStore?.getNickname(userId) ?? null, username: UserStore.getUser(userId)?.username ?? null,
            nickname: member.nick ?? null, roles: member.roles.slice(0, 250).map(id => ({ id, name: GuildRoleStore?.getRole(guildId, id)?.name ?? null })) };
    },
    channel: channelId => {
        const c = visibleChannel(channelId);
        if (!c) return;
        return { type: "channel.snapshot", channelId, guildId: c.guild_id ?? null, name: c.name ?? null, topic: c.topic ?? null,
            parentId: c.parent_id ?? null, channelType: c.type, archived: c.threadMetadata?.archived ?? null,
            locked: c.threadMetadata?.locked ?? null, tags: c.appliedTags ?? [] };
    },
    unread: channelId => {
        const c = visibleChannel(channelId);
        if (!c || !ReadStateStore?.getReadStatesByChannel()?.[channelId]) return;
        return { type: "unread.observed", channelId, guildId: c.guild_id ?? null, unread: ReadStateStore.hasUnread(channelId),
            mentionCount: ReadStateStore.getMentionCount(channelId), lastReadMessageId: ReadStateStore.ackMessageId(channelId), lastMessageId: ReadStateStore.lastMessageId(channelId) };
    },
    games: userId => {
        if (!PresenceStore?.getState()?.statuses?.[userId]) return;
        return { type: "game.observed", userId, activities: PresenceStore.getActivities(userId).slice(0, 10).map(a => ({
            name: a.name, activityType: a.type, details: a.details ?? null, state: a.state ?? null })) };
    },
    guildForChannel: channelId => ChannelStore?.getChannel(channelId)?.guild_id
});
const nativeHelper = () => typeof VencordNative !== "undefined" ? VencordNative.pluginHelpers?.MessageCollector as unknown as (AutoProtection & SyncNative) | undefined : undefined;
// Receiver sync is off unless explicitly armed during always-on setup; the token stays inside the native helper.
const sync: SyncController = new SyncController(collector, storage, nativeHelper, currentAccount, () => always.grantId);
const always = new AlwaysOn(collector, live, storage, nativeHelper, currentAccount, sync);
let watcher: ReturnType<typeof setInterval> | undefined;
let lastDetailsPoll = 0;
let observedAccount: string | undefined;
function ready() {
    const account = currentAccount();
    if (observedAccount && account !== observedAccount) always.accountChanged();
    observedAccount = account; live.checkAccount(); void always.restore(); activity.poll(); if (Date.now() - lastDetailsPoll >= 5000) { lastDetailsPoll = Date.now(); live.pollDetails(); } void sync.tick();
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
        MESSAGE_REACTION_ADD: payload => live.refreshDetails(payload),
        MESSAGE_REACTION_REMOVE: payload => live.refreshDetails(payload),
        MESSAGE_REACTION_REMOVE_ALL: payload => live.refreshDetails(payload),
        MESSAGE_REACTION_REMOVE_EMOJI: payload => live.refreshDetails(payload),
        CHANNEL_PINS_UPDATE: () => queueMicrotask(() => live.pollDetails()),
        GUILD_SCHEDULED_EVENT_CREATE: payload => activity.scheduledEvent(payload),
        GUILD_SCHEDULED_EVENT_UPDATE: payload => activity.scheduledEvent(payload),
        GUILD_SCHEDULED_EVENT_DELETE: payload => activity.scheduledEvent(payload, true),
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
