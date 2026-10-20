import { z } from "zod";

const id = z.string().regex(/^[0-9]{1,20}$/);
const time = z.iso.datetime({ offset: true });
export const activityPermissionSchema = z.strictObject({
    scheduledEvents: z.boolean(), presence: z.boolean(), voice: z.boolean(),
    guildIds: z.array(id).max(100), userIds: z.array(id).max(100), allowExport: z.boolean()
}).superRefine((p, ctx) => {
    if ((p.scheduledEvents || p.voice) && !p.guildIds.length)
        ctx.addIssue({ code: "custom", message: "Choose servers for events and voice." });
    if ((p.presence || p.voice) && !p.userIds.length)
        ctx.addIssue({ code: "custom", message: "Choose people for presence and voice." });
});
export const noActivity = () => ({ scheduledEvents: false, presence: false, voice: false, guildIds: [], userIds: [], allowExport: false });
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
    if (o.type === "scheduled-event.snapshot") return p.scheduledEvents && p.guildIds.includes(o.guildId);
    if (o.type === "presence.observed") return p.presence && p.userIds.includes(o.userId);
    return p.voice && p.guildIds.includes(o.guildId) && p.userIds.includes(o.userId);
}
