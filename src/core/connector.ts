import { derive, envelopeSchema, open } from "./crypto";
import { batchSchema, parseSafe, type Batch } from "./schema";

/** Reference decoder only. A real receiver must ALSO authenticate its principal and check its own ACL/revocations. */
export async function decodeBatch(envelope: unknown, passphrase: string, expectedPrincipal: string, now = Date.now()): Promise<Batch> {
    const e = parseSafe(envelopeSchema, envelope);
    if (e.context !== "coordination-batch/v1") throw new Error("Not a coordination handoff.");
    const batch = parseSafe(batchSchema, await open(e, await derive(passphrase, e.salt), "coordination-batch/v1"));
    const g = batch.grant;
    if (batch.principalId !== expectedPrincipal || g.principalId !== expectedPrincipal || !g.allowExport || g.revokedAt ||
        Date.parse(batch.expiresAt) <= now || Date.parse(g.expiresAt) <= now || Date.parse(batch.createdAt) > now + 60_000)
        throw new Error("Handoff is expired or not authorized for this principal.");
    const ids = new Set<string>();
    for (const e of batch.events) {
        if (e.type !== "message.snapshot" || e.grantId !== g.grantId || e.accountId !== g.accountId || e.source !== g.source ||
            !e.senderId || !g.allowedSenderIds.includes(e.senderId) || JSON.stringify(e.provenance) !== JSON.stringify(g.provenance) ||
            Date.parse(e.expiresAt) <= now || Date.parse(e.expiresAt) > Date.parse(g.expiresAt) ||
            Date.parse(batch.expiresAt) > Date.parse(e.expiresAt) || ids.has(e.eventId))
            throw new Error("Handoff event is outside its permission or duplicates an event ID.");
        ids.add(e.eventId);
    }
    return batch;
}
