import { z } from "zod";

const id = z.string().regex(/^[0-9]{1,20}$/);
const time = z.iso.datetime({ offset: true });
export const activityPermissionSchema = z.strictObject({
    scheduledEvents: z.boolean(), presence: z.boolean(), voice: z.boolean(),
    guildIds: z.array(id).max(100), userIds: z.array(id).max(100), allowExport: z.boolean()
    , members: z.boolean().default(false), channelContext: z.boolean().default(false), unread: z.boolean().default(false), games: z.boolean().default(false),
    channelIds: z.array(id).max(100).default([]),
    memberGuildIds: z.array(id).max(200).default([]),
    namePreference: z.array(z.enum(["personalNickname", "nickname", "displayName", "username"])).min(1).max(4).default(["personalNickname", "nickname", "displayName", "username"])
}).superRefine((p, ctx) => {
    if ((p.scheduledEvents || p.voice) && !p.guildIds.length)
        ctx.addIssue({ code: "custom", message: "Choose servers for events and voice." });
    if ((p.presence || p.voice || p.members || p.games) && !p.userIds.length)
        ctx.addIssue({ code: "custom", message: "Choose people for presence and voice." });
    if ((p.channelContext || p.unread) && !p.channelIds.length)
        ctx.addIssue({ code: "custom", message: "Choose channels for context and unread state." });
    if (new Set([...p.guildIds, ...p.memberGuildIds]).size * p.userIds.length > 1000)
        ctx.addIssue({ code: "custom", message: "Choose at most 1,000 server/person pairs." });
});
export const noActivity = () => ({ scheduledEvents: false, presence: false, voice: false, members: false, channelContext: false, unread: false, games: false, guildIds: [], memberGuildIds: [] as string[], userIds: [], channelIds: [], namePreference: ["personalNickname", "nickname", "displayName", "username"] as ("personalNickname" | "nickname" | "displayName" | "username")[], allowExport: false });
export type ActivityPermission = z.infer<typeof activityPermissionSchema>;
const recurrence = z.strictObject({
    start: time, end: time.nullable(), frequency: z.number().int().min(0).max(3), interval: z.number().int().min(1),
    byWeekday: z.array(z.number().int().min(0).max(6)).max(7).nullable(),
    byNWeekday: z.array(z.strictObject({ n: z.number().int(), day: z.number().int().min(0).max(6) })).max(35).nullable(),
    byMonth: z.array(z.number().int().min(1).max(12)).max(12).nullable(),
    byMonthDay: z.array(z.number().int()).max(31).nullable(),
    byYearDay: z.array(z.number().int()).max(366).nullable(), count: z.number().int().nullable()
});
export const activityObservationSchema = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("person.snapshot"), userId: id, personalNickname: z.string().max(100).nullable(), displayName: z.string().max(100).nullable(), username: z.string().max(100).nullable() }),
    z.strictObject({ type: z.literal("member.snapshot"), guildId: id, userId: id, personalNickname: z.string().max(100).nullable().optional(), username: z.string().max(100).nullable().optional(), displayName: z.string().max(100).nullable(), nickname: z.string().max(100).nullable(), roles: z.array(z.strictObject({ id, name: z.string().max(200).nullable() })).max(250) }),
    z.strictObject({ type: z.literal("channel.snapshot"), channelId: id, guildId: id.nullable(), name: z.string().max(200).nullable(), topic: z.string().max(4096).nullable(), parentId: id.nullable(), channelType: z.number().int(), archived: z.boolean().nullable(), locked: z.boolean().nullable(), tags: z.array(id).max(20) }),
    z.strictObject({ type: z.literal("unread.observed"), channelId: id, guildId: id.nullable(), unread: z.boolean(), mentionCount: z.number().int().nonnegative(), lastReadMessageId: id.nullable(), lastMessageId: id.nullable() }),
    z.strictObject({ type: z.literal("game.observed"), userId: id, activities: z.array(z.strictObject({ name: z.string().max(200), activityType: z.number().int().min(0).max(5), details: z.string().max(1000).nullable(), state: z.string().max(1000).nullable() })).max(10) }),
    z.strictObject({ type: z.literal("scheduled-event.deleted"), guildId: id, scheduledEventId: id }),
    z.strictObject({ type: z.literal("scheduled-event.snapshot"), guildId: id, scheduledEventId: id,
        channelId: id.nullable(), creatorId: id.nullable(), name: z.string().max(1000), description: z.string().max(20_000).nullable(),
        startsAt: time, endsAt: time.nullable(), status: z.enum(["scheduled", "active", "completed", "cancelled"]),
        location: z.string().max(1000).nullable(), recurrence: recurrence.nullable(),
        // Exceptions are not interpreted; a receiver must not invent future occurrences.
        recurrenceExceptionsUnresolved: z.boolean() }),
    z.strictObject({ type: z.literal("presence.observed"), userId: id,
        status: z.enum(["online", "idle", "dnd", "offline"]), previousStatus: z.enum(["online", "idle", "dnd", "offline"]).nullable() }),
    z.strictObject({ type: z.literal("voice.observed"), guildId: id, userId: id,
        channelId: id.nullable(), previousChannelId: id.nullable(),
        observation: z.enum(["baseline", "transition"]),
        previousChannelObservedSince: time.nullable(), observedDurationSeconds: z.number().nonnegative().nullable() })
]);
export type ActivityObservation = z.infer<typeof activityObservationSchema>;
export const activityEventSchema = z.strictObject({
    version: z.literal(1), eventId: z.uuid(), grantId: z.uuid(), accountId: id,
    source: z.literal("vencord-live"), provenanceEvidence: z.literal("client-observed"),
    observedAt: time, expiresAt: time, observation: activityObservationSchema
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export function permitsActivity(p: ActivityPermission, o: ActivityObservation) {
    if (o.type === "person.snapshot") return p.members && p.userIds.includes(o.userId);
    if (o.type === "member.snapshot") return p.members && (p.guildIds.includes(o.guildId) || p.memberGuildIds.includes(o.guildId)) && p.userIds.includes(o.userId);
    if (o.type === "channel.snapshot") return p.channelContext && p.channelIds.includes(o.channelId);
    if (o.type === "unread.observed") return p.unread && p.channelIds.includes(o.channelId);
    if (o.type === "game.observed") return p.games && p.userIds.includes(o.userId);
    if (o.type === "scheduled-event.snapshot" || o.type === "scheduled-event.deleted") return p.scheduledEvents && p.guildIds.includes(o.guildId);
    if (o.type === "presence.observed") return p.presence && p.userIds.includes(o.userId);
    return p.voice && p.guildIds.includes(o.guildId) && p.userIds.includes(o.userId);
}
