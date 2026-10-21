import type { Collector } from "./collector";
import { parseSafe } from "./schema";
import { syncSetupSchema, type Failure, type SyncNative, type SyncSetup, type SyncStorage } from "./sync-config";

const IDLE = 30_000, MORE = 2_000, NUDGE = 5_000, MAX_BACKOFF = 15 * 60_000;
const CHUNK = 500, BUDGET = 20; // at most 20 receiver requests per pass, well under its 120/minute limit

export type SyncState = "off" | "waiting" | "idle" | "syncing" | "error";
class Stop extends Error { constructor(readonly failure: Failure) { super(failure.kind); } }

/**
 * Pushes an export-enabled grant's unacknowledged records to the local receiver through the native helper.
 * Records are marked delivered only after a committed receipt. A batch the receiver refuses is split until the
 * refused events are isolated; they are set aside only when others in the same pass were accepted, so a
 * permission-wide refusal (wrong policy, revoked grant) pauses sync instead of discarding everything.
 */
export class SyncController {
    private blob: string | null | undefined; // undefined = not loaded, null = not configured
    private running = false;
    private nextAt = 0;
    private failures = 0;
    private state: SyncState = "off";
    private message = "Sync to personal-coordination-mcp is off.";
    private lastDeliveredAt: string | null = null;
    private listeners = new Set<() => void>();
    constructor(private collector: Collector, private storage: SyncStorage, private native: () => SyncNative | undefined,
        private accountId: () => string | undefined, private grantId: () => string | undefined, private clock = () => Date.now()) {
        // New captures sync within seconds, unless the receiver is currently backing us off.
        collector.subscribe(() => { if (this.blob && !this.failures) this.nextAt = Math.min(this.nextAt, this.clock() + NUDGE); });
    }
    subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
    private notify() { for (const fn of this.listeners) fn(); }
    private set(state: SyncState, message: string) { this.state = state; this.message = message; this.notify(); }
    get configured() { return !!this.blob; }
    status() {
        const counts = this.collector.status().sync;
        return { configured: !!this.blob, state: this.state, message: this.message, lastDeliveredAt: this.lastDeliveredAt,
            nextAttemptAt: this.blob ? this.nextAt : null, ...counts };
    }
    /** Called by always-on setup after the export-enabled grant exists. Proves port and token before arming. */
    async arm(input: SyncSetup, accountId: string, grantId: string) {
        const setup = parseSafe(syncSetupSchema, input);
        const native = this.native();
        if (!native || !await native.available()) throw new Error("Sync requires Discord Desktop on Windows with operating-system encryption available.");
        const blob = await native.protectSync({ ...setup, accountId, grantId });
        const probe = await native.probeSync(blob, accountId);
        if (!probe.ok) throw new Error(probe.kind === "credentials" ? "The receiver rejected that importer token."
            : probe.kind === "retry" ? `No receiver answered on 127.0.0.1:${setup.port}. Start personal-coordination-mcp and retry.`
            : `The receiver refused this importer (HTTP ${probe.status}). Check that it has checkpoint permission for this account.`);
        await this.storage.writeSync(blob);
        this.blob = blob; this.failures = 0; this.nextAt = 0;
        this.set("idle", "Sync armed. New records are sent to your receiver on this computer.");
    }
    async disarm() {
        this.blob = null; this.failures = 0;
        try { await this.storage.writeSync(undefined); }
        finally { this.set("off", "Sync to personal-coordination-mcp is off."); }
    }
    syncNow() { this.nextAt = 0; return this.tick(); }
    async tick(): Promise<void> {
        if (this.running || this.clock() < this.nextAt) return;
        this.running = true;
        try {
            if (this.blob === undefined) this.blob = (await this.storage.readSync()) ?? null;
            if (!this.blob) { if (this.state !== "off") this.set("off", "Sync to personal-coordination-mcp is off."); return; }
            const native = this.native(), account = this.accountId(), grantId = this.grantId();
            if (!native || !account || !grantId || !this.collector.unlocked) {
                this.nextAt = this.clock() + IDLE;
                if (this.state !== "waiting") this.set("waiting", "Sync is waiting for automatic collection to be running.");
                return;
            }
            const pending = this.collector.pendingSync(grantId);
            if (!pending.length) {
                this.nextAt = this.clock() + IDLE; this.failures = 0;
                if (this.state !== "idle") this.set("idle", "Up to date.");
                return;
            }
            this.set("syncing", `Sending ${pending.length} record(s)…`);
            const queue = [pending.slice(0, CHUNK)], refused: string[] = [];
            let budget = BUDGET, delivered = 0, lastRefusal = 0;
            while (queue.length && budget-- > 0) {
                const ids = queue.shift()!;
                let batch;
                try { batch = this.collector.syncBatch(grantId, ids); } catch { continue; } // replaced or expired meanwhile
                const result = await native.deliver(this.blob, account, batch);
                if (result.ok) {
                    delivered += await this.collector.markSynced(grantId, batch.events.map(e => e.eventId), "delivered");
                    this.lastDeliveredAt = result.receipt.committedAt;
                } else if (result.kind !== "refused") throw new Stop(result);
                else if (ids.length > 1) { const mid = Math.ceil(ids.length / 2); queue.unshift(ids.slice(0, mid), ids.slice(mid)); lastRefusal = result.status; }
                else { refused.push(ids[0]!); lastRefusal = result.status; }
            }
            if (refused.length && !delivered) throw new Stop({ ok: false, kind: "refused", status: lastRefusal });
            if (refused.length) await this.collector.markSynced(grantId, refused, "refused");
            this.failures = 0;
            const remaining = this.collector.pendingSync(grantId).length;
            this.nextAt = this.clock() + (remaining ? MORE : IDLE);
            this.set("idle", `Sent ${delivered} record(s)${refused.length ? `; ${refused.length} refused by the receiver and set aside` : ""}${remaining ? `; ${remaining} still pending` : "; up to date"}.`);
        } catch (error) {
            this.failures++;
            this.nextAt = this.clock() + Math.min(MAX_BACKOFF, IDLE * 2 ** (this.failures - 1));
            const f = error instanceof Stop ? error.failure : undefined;
            this.set("error", !f ? "Sync failed locally; retrying later."
                : f.kind === "credentials" ? "The receiver rejected the sync token. Stop collecting and set up sync again with a current token."
                : f.kind === "retry" ? (f.status ? `Receiver busy (HTTP ${f.status}); retrying automatically.` : "Receiver not reachable; retrying automatically.")
                : `Receiver refused these records (HTTP ${f.status}). Check its collector policy: purpose, account scope, continuous, sources. Retrying later.`);
        } finally { this.running = false; }
    }
}
