import { z } from "zod";
import { activityEventSchema, activityPermissionSchema, noActivity } from "./activity-schema";

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_VAULT_BYTES = 8 * 1024 * 1024;
export const id = z.string().regex(/^[0-9]{1,20}$/);
export const instant = z.iso.datetime({ offset: true });
export const source = z.enum(["manual", "discord-data-package", "vencord-live"]);
export const displayName = z.string().trim().min(1).max(100);

export const provenanceSchema = z.strictObject({
    kind: z.enum(["guild-channel", "guild-thread", "dm", "group-dm", "unknown"]),
    guildId: id.nullable(), guildName: z.string().max(200).nullable(),
    channelId: id, channelName: z.string().max(200).nullable(),
    parentChannelId: id.nullable(), threadId: id.nullable(),
    participantIds: z.array(id).max(100)
}).superRefine((p, c) => {
    const bad = (message: string) => c.addIssue({ code: "custom", message });
    if (p.kind.startsWith("guild-") && !p.guildId) bad("A server ID is required.");
    if (p.kind === "guild-thread" && (!p.parentChannelId || p.threadId !== p.channelId))
        bad("A thread uses its own channel ID and requires its parent channel ID.");
    if (p.kind !== "guild-thread" && (p.parentChannelId || p.threadId)) bad("Only threads have parent/thread IDs.");
    if ((p.kind === "dm" || p.kind === "group-dm") && (p.guildId || p.guildName)) bad("DMs have no server.");
    if (new Set(p.participantIds).size !== p.participantIds.length) bad("Duplicate participant IDs.");
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const messageSchema = z.strictObject({
    messageId: id, senderId: id, createdAt: instant,
    editedAt: instant.nullable(), content: z.string().max(20_000)
});
export const manualInputSchema = z.strictObject({
    version: z.literal(1), accountId: id, provenance: provenanceSchema,
    messages: z.array(messageSchema).min(1).max(1000)
});

export const grantDraftSchema = z.strictObject({
    source, accountId: id, scope: z.enum(["conversation", "account"]).default("conversation"),
    activity: activityPermissionSchema.default(noActivity),
    provenance: provenanceSchema.nullable(),
    allowedSenderIds: z.array(id).max(100),
    purpose: z.string().trim().min(5).max(300),
    continuous: z.boolean().default(false), expiresAt: instant.nullable(),
    retentionDays: z.number().int().min(1).max(30),
    allowExport: z.boolean(),
    principalId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/)
}).superRefine((g, c) => {
    if ((g.activity.scheduledEvents || g.activity.presence || g.activity.voice) && (g.source !== "vencord-live" || g.scope !== "account"))
        c.addIssue({ code: "custom", message: "Activity requires an account-wide live permission." });
    if (g.continuous ? g.source !== "vencord-live" || g.expiresAt !== null : g.expiresAt === null)
        c.addIssue({ code: "custom", message: "Only continuous live permissions may have no expiry." });
    if (g.scope === "account" && (g.source !== "vencord-live" || g.provenance !== null || g.allowedSenderIds.length !== 0))
        c.addIssue({ code: "custom", message: "Account scope is live-only, with per-event provenance and all senders." });
    if (g.scope === "conversation" && (!g.provenance || !g.allowedSenderIds.length))
        c.addIssue({ code: "custom", message: "Conversation scope requires provenance and explicit senders." });
    if (g.source === "discord-data-package" && (g.allowedSenderIds.length !== 1 || g.allowedSenderIds[0] !== g.accountId))
        c.addIssue({ code: "custom", message: "A data package contains only the account owner's messages." });
});
export const grantSchema = grantDraftSchema.safeExtend({
    grantId: z.uuid(), grantedAt: instant,
    authority: z.literal("user-attested"), revokedAt: instant.nullable()
});
export type Grant = z.infer<typeof grantSchema>;
export function grantExpiry(grant: { expiresAt: string | null }): number { return grant.expiresAt === null ? Infinity : Date.parse(grant.expiresAt); }

export function permitsSender(grant: Grant, senderId: string): boolean {
    return grant.scope === "account" || grant.allowedSenderIds.includes(senderId);
}
export function permitsProvenance(grant: Grant, provenance: Provenance): boolean {
    return grant.scope === "account"
        ? provenance.kind !== "unknown" && (!(provenance.kind === "dm" || provenance.kind === "group-dm") || provenance.participantIds.includes(grant.accountId))
        : !!grant.provenance && sameConversation(grant.provenance, provenance);
}

const baseEvent = {
    version: z.literal(1), eventId: z.uuid(), messageId: id,
    source: z.enum(["manual", "discord-data-package", "vencord-live", "authorized-bot"]),
    accountId: id, provenance: provenanceSchema,
    provenanceEvidence: z.enum(["user-supplied", "client-observed", "authorized-source"]),
    grantId: z.uuid(), observedAt: instant, expiresAt: instant,
    sourceTimestamp: instant.nullable(), senderId: id.nullable(),
    // Display name the client showed for the sender when observed. Optional: older exports and files omit it.
    senderName: displayName.optional()
};
export const eventSchema = z.discriminatedUnion("type", [
    z.strictObject({ ...baseEvent, type: z.literal("message.snapshot"),
        senderId: id, createdAt: instant, editedAt: instant.nullable(), content: z.string().max(20_000) }),
    z.strictObject({ ...baseEvent, type: z.literal("message.create"),
        source: z.enum(["authorized-bot", "vencord-live"]), senderId: id, createdAt: instant, content: z.string().max(20_000).nullable() }),
    z.strictObject({ ...baseEvent, type: z.literal("message.update"), source: z.enum(["authorized-bot", "vencord-live"]),
        // Missing content means unchanged/unavailable; an empty string is an actual supplied value.
        patch: z.strictObject({ content: z.string().max(20_000).optional(), editedAt: instant.nullable().optional() }) }),
    z.strictObject({ ...baseEvent, type: z.literal("message.delete"), source: z.enum(["authorized-bot", "vencord-live"]) })
]);
export type MessageEvent = z.infer<typeof eventSchema>;

export const auditSchema = z.strictObject({
    auditId: z.uuid(), at: instant,
    action: z.enum(["grant", "import", "export", "revoke", "prune", "capacity-prune", "live-start", "live-create", "live-update", "live-delete", "loaded-snapshot", "activity-permission", "activity-save", "activity-export",
        "sync-delivered", "sync-refused", "sync-dropped"]),
    grantId: z.uuid().nullable(), count: z.number().int().nonnegative()
});
export const stateSchema = z.strictObject({
    version: z.literal(1), grants: z.array(grantSchema).max(100),
    // `sync` is set only after the receiver's committed receipt (delivered) or after it refused this one
    // event while accepting others (refused). Replacing a record (edit/delete) starts it pending again.
    records: z.array(z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/), event: eventSchema,
        sync: z.strictObject({ outcome: z.enum(["delivered", "refused"]), at: instant }).optional() })).max(5000),
    activities: z.array(activityEventSchema).max(2000).default([]),
    audit: z.array(auditSchema).max(500)
});
export type State = z.infer<typeof stateSchema>;
export const batchSchema = z.strictObject({
    protocol: z.literal("personal-coordination/ingest-file"), version: z.literal(1),
    batchId: z.uuid(), createdAt: instant, expiresAt: instant,
    audience: z.literal("personal-coordination-mcp"), principalId: z.string().min(1).max(100),
    grant: grantSchema, events: z.array(eventSchema).min(1).max(5000)
});
export type Batch = z.infer<typeof batchSchema>;
export const activityBatchSchema = z.strictObject({
    protocol: z.literal("personal-coordination/activity-file"), version: z.literal(1),
    batchId: z.uuid(), createdAt: instant, expiresAt: instant,
    audience: z.literal("personal-coordination-mcp"), principalId: z.string().min(1).max(100),
    grant: grantSchema, events: z.array(activityEventSchema).min(1).max(2000)
});

export const liveObservationSchema = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("snapshot"), messageId: id, channelId: id, senderId: id, senderName: displayName.optional(),
        createdAt: instant, editedAt: instant.nullable(), content: z.string().max(20_000) }),
    z.strictObject({ type: z.literal("create"), messageId: id, channelId: id, senderId: id, senderName: displayName.optional(),
        createdAt: instant, content: z.string().max(20_000) }),
    z.strictObject({ type: z.literal("update"), messageId: id, channelId: id, senderId: id.optional(), senderName: displayName.optional(),
        content: z.string().max(20_000).optional(), editedAt: instant.nullable().optional() }),
    z.strictObject({ type: z.literal("delete"), messageId: id, channelId: id })
]);
export type LiveObservation = z.infer<typeof liveObservationSchema>;

export function sameConversation(a: Provenance, b: Provenance): boolean {
    return a.kind === b.kind && a.channelId === b.channelId && a.guildId === b.guildId &&
        a.parentChannelId === b.parentChannelId && a.threadId === b.threadId &&
        [...a.participantIds].sort().join(",") === [...b.participantIds].sort().join(",");
}

export function parseJson(text: string): unknown {
    if (new TextEncoder().encode(text).byteLength > MAX_INPUT_BYTES) throw new Error("File exceeds the 2 MiB import limit.");
    try { return JSON.parse(text); } catch { throw new Error("Invalid JSON file."); }
}

export function parseSafe<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    // Never echo untrusted content, identifiers, or parser diagnostics into logs/UI errors.
    if (!parsed.success) throw new Error("Invalid format or missing fields. See the documented examples.");
    return parsed.data;
}
