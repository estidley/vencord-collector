import { derive, envelopeSchema, open } from "./crypto";
import { activityBatchSchema, batchSchema, grantExpiry, parseSafe, permitsProvenance, permitsSender, type Batch } from "./schema";
import { permitsActivity } from "./activity-schema";

/** Reference decoder only. A real receiver must ALSO authenticate its principal and check its own ACL/revocations. */
export async function decodeBatch(envelope: unknown, passphrase: string, expectedPrincipal: string, now = Date.now()): Promise<Batch> {
    const e = parseSafe(envelopeSchema, envelope);
    if (e.context !== "coordination-batch/v1") throw new Error("Not a coordination handoff.");
    const batch = parseSafe(batchSchema, await open(e, await derive(passphrase, e.salt), "coordination-batch/v1"));
    const g = batch.grant;
    if (batch.principalId !== expectedPrincipal || g.principalId !== expectedPrincipal || !g.allowExport || g.revokedAt ||
        Date.parse(batch.expiresAt) <= now || grantExpiry(g) <= now || Date.parse(batch.createdAt) > now + 60_000)
        throw new Error("Handoff is expired or not authorized for this principal.");
    const ids = new Set<string>();
    for (const e of batch.events) {
        const allowedType = g.source === "vencord-live"
            ? ["message.snapshot", "message.create", "message.update", "message.delete"].includes(e.type) && e.provenanceEvidence === "client-observed"
            : e.type === "message.snapshot";
        if (!allowedType || e.grantId !== g.grantId || e.accountId !== g.accountId || e.source !== g.source ||
            !e.senderId || !permitsSender(g, e.senderId) || !permitsProvenance(g, e.provenance) ||
            Date.parse(e.expiresAt) <= now || Date.parse(e.expiresAt) > grantExpiry(g) ||
            Date.parse(batch.expiresAt) > Date.parse(e.expiresAt) || ids.has(e.eventId))
            throw new Error("Handoff event is outside its permission or duplicates an event ID.");
        ids.add(e.eventId);
    }
    return batch;
}

/** Activity handoffs are separate so older message-only receivers fail closed. */
export async function decodeActivityBatch(envelope: unknown, passphrase: string, expectedPrincipal: string, now = Date.now()) {
    const e = parseSafe(envelopeSchema, envelope);
    const batch = parseSafe(activityBatchSchema, await open(e, await derive(passphrase, e.salt), "coordination-batch/v1"));
    const g = batch.grant;
    if (g.source !== "vencord-live" || g.scope !== "account" || !g.activity.allowExport || g.revokedAt ||
        g.principalId !== expectedPrincipal || batch.principalId !== expectedPrincipal || grantExpiry(g) <= now ||
        Date.parse(batch.expiresAt) <= now || Date.parse(batch.createdAt) > now + 60_000) throw new Error("Activity handoff is not authorized.");
    const ids = new Set<string>();
    for (const event of batch.events) {
        if (event.accountId !== g.accountId || event.grantId !== g.grantId || !permitsActivity(g.activity, event.observation) ||
            Date.parse(event.expiresAt) <= now || Date.parse(event.expiresAt) > grantExpiry(g) ||
            Date.parse(batch.expiresAt) > Date.parse(event.expiresAt) || Date.parse(event.observedAt) > now + 60_000 || ids.has(event.eventId))
            throw new Error("Activity handoff contains an out-of-scope or duplicate event.");
        ids.add(event.eventId);
    }
    return batch;
}
