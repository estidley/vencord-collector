import { derive, digest, envelopeSchema, open, seal, type Envelope, type Secret } from "./crypto";
import { parseImport } from "./importer";
import { batchSchema, grantDraftSchema, parseSafe, stateSchema, type Grant, type MessageEvent, type State } from "./schema";
import type { VaultStorage } from "./storage";

const DAY = 86_400_000;
const fresh = (): State => ({ version: 1, grants: [], records: [], audit: [] });
const uid = () => crypto.randomUUID();

export class Collector {
    private secret?: Secret;
    private state?: State;
    private revision = 0;
    private epoch = 0;
    private busy = false;
    private listeners = new Set<() => void>();
    private enabled = true;
    constructor(private storage: VaultStorage, private clock = () => Date.now()) {}
    get unlocked() { return !!this.secret && !!this.state; }
    get available() { return this.enabled; }
    subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    private notify() { for (const listener of this.listeners) listener(); }
    suspend() { this.enabled = false; this.lock(); }
    resume() { this.enabled = true; this.notify(); }
    lock() { this.epoch++; this.secret = undefined; this.state = undefined; this.notify(); }
    private now() { return new Date(this.clock()).toISOString(); }
    private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
        if (this.busy) throw new Error("Another operation is running. Please retry after it finishes.");
        this.busy = true;
        try { return await fn(); } finally { this.busy = false; }
    }
    private check(epoch: number) {
        if (epoch !== this.epoch || !this.unlocked) throw new Error("Buffer locked. Unlock and retry.");
    }
    async unlock(passphrase: string): Promise<void> {
        return this.exclusive(async () => {
            if (!this.enabled) throw new Error("Enable the plugin first.");
            this.lock();
            const epoch = this.epoch;
            const stored = await this.storage.read();
            const envelope = stored ? parseSafe(envelopeSchema, stored.envelope) : undefined;
            const secret = await derive(passphrase, envelope?.salt);
            const state = envelope ? parseSafe(stateSchema, await open(envelope, secret, "collector-vault/v1")) : fresh();
            if (epoch !== this.epoch) throw new Error("Unlock cancelled.");
            this.secret = secret; this.state = state; this.revision = stored?.revision ?? 0;
            try {
                const count = this.pruneState(state);
                if (!stored || count) await this.save(state, epoch);
                this.notify();
            } catch (e) { this.lock(); throw e; }
        });
    }
    private audit(state: State, action: State["audit"][number]["action"], grantId: string | null, count: number) {
        state.audit.push({ auditId: uid(), at: this.now(), action, grantId, count });
        state.audit = state.audit.slice(-500);
    }
    private pruneState(state: State) {
        const before = state.records.length;
        const activeIds = new Set(state.grants.filter(g => !g.revokedAt && Date.parse(g.expiresAt) > this.clock()).map(g => g.grantId));
        state.records = state.records.filter(r => Date.parse(r.event.expiresAt) > this.clock() && activeIds.has(r.event.grantId));
        const count = before - state.records.length;
        if (count) this.audit(state, "prune", null, count);
        return count;
    }
    private async save(state: State, epoch: number) {
        this.check(epoch);
        const checked = parseSafe(stateSchema, state);
        const encrypted = await seal(checked, this.secret!, "collector-vault/v1");
        this.check(epoch);
        const revision = await this.storage.compareAndSet(this.revision, encrypted);
        this.check(epoch);
        this.revision = revision; this.state = checked;
        this.notify();
    }
    private async mutate<T>(fn: (state: State, epoch: number) => Promise<T> | T): Promise<T> {
        return this.exclusive(async () => {
            const epoch = this.epoch;
            this.check(epoch);
            const state = structuredClone(this.state!);
            this.pruneState(state);
            const result = await fn(state, epoch);
            await this.save(state, epoch);
            return result;
        });
    }
    private active(state: State, grantId: string): Grant {
        const grant = state.grants.find(g => g.grantId === grantId);
        if (!grant || grant.revokedAt || Date.parse(grant.expiresAt) <= this.clock()) throw new Error("Permission is missing, expired, or revoked.");
        return grant;
    }
    status() {
        if (!this.state) return { unlocked: false, count: 0, grants: [] as Grant[], audit: [] as State["audit"] };
        const state = structuredClone(this.state);
        this.pruneState(state);
        return { unlocked: true, count: state.records.length, grants: state.grants, audit: state.audit };
    }
    async grant(input: unknown, attested: boolean): Promise<Grant> {
        if (attested !== true) throw new Error("Confirm your authority and permission for this specific conversation first.");
        const draft = parseSafe(grantDraftSchema, input);
        const expires = Date.parse(draft.expiresAt);
        if (expires <= this.clock() || expires > this.clock() + 30 * DAY) throw new Error("Permission must expire within the next 30 days.");
        return this.mutate(state => {
            if (state.grants.length >= 100) throw new Error("Permission history is full. Start a new browser profile after managing existing exports.");
            const grant: Grant = { ...draft, grantId: uid(), grantedAt: this.now(), authority: "user-attested", revokedAt: null };
            state.grants.push(grant);
            this.audit(state, "grant", grant.grantId, 0);
            return structuredClone(grant);
        });
    }
    preview(text: string, grantId: string) {
        this.check(this.epoch);
        const grant = this.active(this.state!, grantId);
        const input = parseImport(text, grant);
        if (input.accountId !== grant.accountId || JSON.stringify(input.provenance) !== JSON.stringify(grant.provenance))
            throw new Error("File does not match the permitted account and conversation.");
        if (input.messages.some(m => !grant.allowedSenderIds.includes(m.senderId))) throw new Error("File contains a sender outside the permission.");
        return input;
    }
    async import(text: string, grantId: string, confirmed: boolean): Promise<number> {
        if (confirmed !== true) throw new Error("Review the preview and confirm this import first.");
        return this.mutate(async state => {
            const grant = this.active(state, grantId);
            const input = this.preview(text, grantId);
            const known = new Set(state.records.map(r => r.digest));
            let count = 0;
            for (const m of input.messages) {
                const hash = await digest({ grantId, source: grant.source, accountId: input.accountId, provenance: input.provenance, ...m });
                if (known.has(hash)) continue;
                const event: MessageEvent = { version: 1, type: "message.snapshot", eventId: uid(), grantId,
                    source: grant.source, accountId: input.accountId, provenance: input.provenance,
                    provenanceEvidence: "user-supplied", observedAt: this.now(), sourceTimestamp: m.createdAt,
                    expiresAt: new Date(Math.min(Date.parse(grant.expiresAt), this.clock() + grant.retentionDays * DAY)).toISOString(), ...m };
                state.records.push({ digest: hash, event }); known.add(hash); count++;
            }
            // Recheck expiry after asynchronous work. Invalid imports commit nothing.
            this.active(state, grantId);
            if (state.records.length > 5000) throw new Error("Buffer capacity reached (5000 snapshots). Prune or revoke a conversation.");
            this.audit(state, "import", grantId, count);
            return count;
        });
    }
    async revoke(grantId: string): Promise<number> {
        return this.mutate(state => {
            const grant = state.grants.find(g => g.grantId === grantId);
            if (!grant) throw new Error("Permission not found.");
            grant.revokedAt = this.now(); grant.allowExport = false;
            const count = state.records.filter(r => r.event.grantId === grantId).length;
            state.records = state.records.filter(r => r.event.grantId !== grantId);
            this.audit(state, "revoke", grantId, count);
            return count;
        });
    }
    async prune(): Promise<void> { await this.mutate(() => {}); }
    async export(grantId: string, passphrase: string, confirmed: boolean): Promise<Envelope> {
        if (confirmed !== true) throw new Error("Confirm export to the named principal first.");
        return this.mutate(async state => {
            const grant = this.active(state, grantId);
            if (!grant.allowExport) throw new Error("This permission allows local storage only.");
            const events = state.records.filter(r => r.event.grantId === grantId).map(r => r.event);
            if (!events.length) throw new Error("No eligible snapshots to export.");
            const batch = parseSafe(batchSchema, {
                protocol: "personal-coordination/ingest-file", version: 1, batchId: uid(), createdAt: this.now(),
                expiresAt: new Date(Math.min(...events.map(e => Date.parse(e.expiresAt)))).toISOString(),
                audience: "personal-coordination-mcp", principalId: grant.principalId, grant, events
            });
            const secret = await derive(passphrase);
            const encrypted = await seal(batch, secret, "coordination-batch/v1");
            this.active(state, grantId);
            if (Date.parse(batch.expiresAt) <= this.clock()) throw new Error("The export expired. Prune and retry.");
            this.audit(state, "export", grantId, events.length);
            return encrypted;
        });
    }
}
