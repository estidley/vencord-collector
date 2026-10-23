import { z } from "zod";

const id = z.string().regex(/^[0-9]{1,20}$/);
const text = z.string().max(2000);
// URLs are inert references, never fetched or rendered as active content by the collector.
export const referenceUrl = z.string().max(2048).refine(value => {
    try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
});
const emoji = z.strictObject({ id: id.nullable(), name: z.string().max(100).nullable() });
export const detailKeys = ["replies", "mentions", "attachments", "links", "embeds", "reactions", "poll", "pinned"] as const;
export const detailsSchema = z.strictObject({
    replies: z.strictObject({ messageId: id.nullable(), channelId: id.nullable(), guildId: id.nullable() }).nullable().optional(),
    mentions: z.strictObject({ userIds: z.array(id).max(100), roleIds: z.array(id).max(100), channelIds: z.array(id).max(100).default([]), everyone: z.boolean() }).optional(),
    attachments: z.array(z.strictObject({ id, filename: z.string().max(255), size: z.number().int().nonnegative(), contentType: z.string().max(200).nullable(), url: referenceUrl.nullable() })).max(20).optional(),
    links: z.array(referenceUrl).max(50).optional(),
    embeds: z.array(z.strictObject({ title: text.nullable(), description: z.string().max(6000).nullable(), url: referenceUrl.nullable(), fields: z.array(z.strictObject({ name: text, value: text })).max(25) })).max(10).optional(),
    reactions: z.array(z.strictObject({ emoji, count: z.number().int().nonnegative(), me: z.boolean().nullable() })).max(100).optional(),
    poll: z.strictObject({ question: text, answers: z.array(z.strictObject({ id: z.number().int(), text, count: z.number().int().nonnegative().nullable(), me: z.boolean().nullable() })).max(20), expiresAt: z.iso.datetime({ offset: true }).nullable(), finalized: z.boolean().nullable(), multiple: z.boolean() }).nullable().optional(),
    pinned: z.boolean().optional()
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32768, "Message details exceed 32 KiB.");
export type Details = z.infer<typeof detailsSchema>;
export type DetailKey = typeof detailKeys[number];
const str = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : null;
const url = (v: unknown) => referenceUrl.safeParse(v).success ? v as string : null;
const list = (v: unknown, max: number): any[] => Array.isArray(v) ? v.slice(0, max) : [];
const ids = (v: unknown) => list(v, 100).map(x => typeof x === "string" ? x : x?.id).filter(x => id.safeParse(x).success);

/** Whitelist fields. Never retain raw objects, HTML, code, or referenced-message bodies. */
export function messageDetails(raw: unknown, allowed: readonly string[]): Details | undefined {
    if (!raw || typeof raw !== "object") return;
    const m = raw as Record<string, any>, out: Record<string, unknown> = {};
    const add = (key: DetailKey, value: unknown) => {
        if (!allowed.includes(key)) return;
        const checked = detailsSchema.shape[key].safeParse(value);
        if (checked.success && checked.data !== undefined) out[key] = checked.data;
    };
    if ("message_reference" in m || "messageReference" in m) {
        const r = m.message_reference ?? m.messageReference;
        add("replies", r ? { messageId: r.message_id ?? r.messageId ?? null, channelId: r.channel_id ?? r.channelId ?? null, guildId: r.guild_id ?? r.guildId ?? null } : null);
    }
    if ("mentions" in m) add("mentions", { userIds: ids(m.mentions), roleIds: ids(m.mention_roles ?? m.mentionRoles), channelIds: ids(m.mention_channels ?? m.mentionChannels), everyone: m.mention_everyone === true || m.mentionEveryone === true });
    if ("attachments" in m) add("attachments", list(m.attachments, 20).map(a => ({ id: a.id, filename: str(a.filename, 255), size: a.size, contentType: str(a.content_type ?? a.contentType, 200), url: url(a.url) })));
    if (typeof m.content === "string") add("links", [...new Set((m.content.match(/https?:\/\/[^\s<>"\[\]]+/g) ?? []).map(url).filter(Boolean))].slice(0, 50));
    if ("embeds" in m) add("embeds", list(m.embeds, 10).map(e => ({ title: str(e.title, 2000), description: str(e.description, 6000), url: url(e.url), fields: list(e.fields, 25).map(f => ({ name: str(f.name, 2000) ?? "", value: str(f.value, 2000) ?? "" })) })));
    if ("reactions" in m) add("reactions", list(m.reactions, 100).map(r => ({ emoji: { id: r.emoji?.id ?? null, name: str(r.emoji?.name, 100) }, count: r.count, me: typeof r.me === "boolean" ? r.me : null })));
    if ("poll" in m) {
        const p = m.poll;
        add("poll", p ? { question: str(p.question?.text, 2000) ?? "", answers: list(p.answers, 20).map(a => {
            const count = list(p.results?.answer_counts ?? p.results?.answerCounts, 20).find(c => c.id === (a.answer_id ?? a.answerId));
            return { id: a.answer_id ?? a.answerId, text: str((a.poll_media ?? a.pollMedia)?.text, 2000) ?? "", count: count?.count ?? null, me: count?.me_voted ?? count?.meVoted ?? null };
        }), expiresAt: p.expiry ?? null, finalized: p.results?.is_finalized ?? p.results?.isFinalized ?? null, multiple: p.allow_multiselect === true || p.allowMultiselect === true } : null);
    }
    if (typeof m.pinned === "boolean") add("pinned", m.pinned);
    const checked = detailsSchema.safeParse(out);
    return checked.success && Object.keys(out).length && JSON.stringify(out).length <= 32768 ? checked.data : undefined;
}

export function filterDetails(details: Details | undefined, allowed: readonly string[]): Details | undefined {
    if (!details) return;
    const result = Object.fromEntries(Object.entries(details).filter(([key]) => allowed.includes(key)));
    return Object.keys(result).length ? detailsSchema.parse(result) : undefined;
}
