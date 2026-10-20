import { derive, digest, envelopeSchema, open, seal, type Envelope, type Secret } from "./crypto";
import { parseImport } from "./importer";
import { batchSchema, grantDraftSchema, liveObservationSchema, parseSafe, permitsProvenance, permitsSender, provenanceSchema, stateSchema, type Grant, type MessageEvent, type Provenance, type State } from "./schema";
import type { VaultStorage } from "./storage";

const DAY = 86_400_000;
const fresh = (): State => ({ version: 1, grants: [], records: [], audit: [] });
const uid = () => crypto.randomUUID();

export class Collector {
    private secret?: Secret;
    private state?: State;
    private revision = 0;
    private epoch = 0;
    private pending: Promise<unknown> = Promise.resolve();
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
        const task = this.pending.then(fn);
        this.pending = task.catch(() => {});
        return task;
    }
    private check(epoch: number) {
        if (epoch !== this.epoch || !this.unlocked) throw new Error("Buffer locked. Unlock and retry.");
    }
    async unlock(passphrase: string): Promise<void> {
        this.lock();
        const epoch = this.epoch;
        return this.exclusive(async () => {
            if (!this.enabled) throw new Error("Enable the plugin first.");
            if (epoch !== this.epoch) throw new Error("Unlock cancelled.");
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
        const epoch = this.epoch;
        return this.exclusive(async () => {
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
                // A still-retained observed deletion also prevents reimporting an older file copy.
                if (state.records.some(r => r.event.type === "message.delete" && r.event.accountId === input.accountId &&
                    r.event.provenance.channelId === input.provenance.channelId && r.event.messageId === m.messageId)) continue;
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
    async beginLive(grantId: string, accountId: string, observed?: Provenance): Promise<Grant> {
        return this.mutate(state => {
            const grant = this.active(state, grantId);
            if (grant.source !== "vencord-live" || grant.accountId !== accountId ||
                (grant.scope !== "account" && (!observed || !permitsProvenance(grant, observed))))
                throw new Error("The live permission does not match this account and conversation.");
            this.audit(state, "live-start", grantId, 0);
            return structuredClone(grant);
        });
    }
    async captureLive(grantId: string, accountId: string, observation: unknown, observed?: Provenance): Promise<boolean> {
        const input = parseSafe(liveObservationSchema, observation);
        const suppliedProvenance = observed ? parseSafe(provenanceSchema, observed) : undefined;
        return this.mutate(async state => {
            const grant = this.active(state, grantId);
            if (grant.source !== "vencord-live" || grant.accountId !== accountId ||
                (grant.scope !== "account" && grant.provenance?.channelId !== input.channelId))
                throw new Error("Client event is outside its live permission.");
            const sameMessage = (e: MessageEvent) => e.accountId === accountId && e.provenance.channelId === input.channelId && e.messageId === input.messageId;
            const previous = state.records.find(r => r.event.grantId === grantId && sameMessage(r.event))?.event ??
                (input.type === "delete" ? state.records.find(r => sameMessage(r.event))?.event : undefined);
            // Never resurrect deleted content, fetch missing messages, or invent an original sender.
            if (state.records.some(r => sameMessage(r.event) && r.event.type === "message.delete")) return false;
            if (input.type !== "create" && !previous) return false;
            const provenance = suppliedProvenance ?? (input.type === "delete" ? previous?.provenance : undefined) ?? grant.provenance;
            if (!provenance || provenance.channelId !== input.channelId || !permitsProvenance(grant, provenance))
                throw new Error("Client provenance is outside its live permission.");
            const senderId = input.type === "create" ? input.senderId : previous?.senderId;
            if (!senderId || !permitsSender(grant, senderId)) return false;
            if (input.type === "update" && input.senderId && input.senderId !== senderId) throw new Error("Client event sender changed unexpectedly.");
            const base = { version: 1 as const, eventId: crypto.randomUUID(), messageId: input.messageId,
                source: "vencord-live" as const, accountId, provenance,
                provenanceEvidence: "client-observed" as const, grantId, observedAt: this.now(), senderId,
                expiresAt: new Date(Math.min(previous ? Date.parse(previous.expiresAt) : Infinity,
                    Date.parse(grant.expiresAt), this.clock() + grant.retentionDays * DAY)).toISOString() };
            let event: MessageEvent;
            if (input.type === "create") {
                if (previous) return false;
                event = { ...base, type: "message.create", sourceTimestamp: input.createdAt, createdAt: input.createdAt, content: input.content };
            } else if (input.type === "update") {
                if (input.content === undefined && input.editedAt === undefined) return false;
                const oldContent = previous!.type === "message.update" ? previous!.patch.content : "content" in previous! ? previous!.content : undefined;
                const oldEdited = previous!.type === "message.update" ? previous!.patch.editedAt : undefined;
                if ((input.content === undefined || input.content === oldContent) && (input.editedAt === undefined || input.editedAt === oldEdited)) return false;
                event = { ...base, type: "message.update", sourceTimestamp: input.editedAt ?? null,
                    patch: { ...(oldContent !== undefined && oldContent !== null ? { content: oldContent } : {}),
                        ...(oldEdited !== undefined ? { editedAt: oldEdited } : {}),
                        ...(input.content !== undefined ? { content: input.content } : {}),
                        ...(input.editedAt !== undefined ? { editedAt: input.editedAt } : {}) } };
            } else {
                event = { ...base, type: "message.delete", sourceTimestamp: null };
            }
            // Edits replace live content; deletes purge all buffered versions, including imported copies.
            state.records = state.records.filter(r => !(sameMessage(r.event) && (input.type === "delete" || r.event.source === "vencord-live")));
            state.records.push({ digest: await digest(event), event });
            this.active(state, grantId);
            if (state.records.length > 5000) throw new Error("Buffer capacity reached. Live capture must stop.");
            this.audit(state, `live-${input.type}`, grantId, 1);
            return true;
        });
    }
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
