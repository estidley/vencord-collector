import { z } from "zod";
import { type Grant, id, manualInputSchema, messageSchema, parseJson, parseSafe } from "./schema";

const packageRows = z.array(z.strictObject({
    ID: id, Timestamp: z.string().max(60), Contents: z.string().max(20_000),
    Attachments: z.union([z.string().max(100_000), z.array(z.string().max(2000)).max(100)]).optional()
})).min(1).max(1000);

function packageTime(raw: string): string {
    // Legacy package timestamps have a documented adapter convention: unzoned values are UTC.
    const normalized = raw.replace(" ", "T");
    const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(normalized) ? normalized + "Z" : normalized;
    const parsed = z.iso.datetime({ offset: true }).safeParse(zoned);
    if (!parsed.success) throw new Error("Unrecognized package timestamp. Use the documented normalized JSON format.");
    return new Date(parsed.data).toISOString();
}

export function parseImport(text: string, grant: Grant) {
    const input = parseJson(text);
    if (grant.source === "discord-data-package") {
        const rows = parseSafe(packageRows, input);
        return {
            version: 1 as const, accountId: grant.accountId, provenance: grant.provenance,
            messages: rows.map(row => parseSafe(messageSchema, {
                messageId: row.ID, senderId: grant.accountId, createdAt: packageTime(row.Timestamp),
                editedAt: null, content: row.Contents
            }))
        };
    }
    return parseSafe(manualInputSchema, input);
}
