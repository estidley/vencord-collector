import { messageDetails } from "./details";
import { Collector } from "./collector";
import { grantExpiry, id, liveObservationSchema, MAX_INPUT_BYTES, parseSafe, permitsProvenance, permitsSender, provenanceSchema, type Grant, type LiveObservation, type Provenance } from "./schema";

export interface LiveHost {
    accountId(): string | undefined;
    selectedChannelId(): string | undefined;
    provenance(channelId: string): Provenance | undefined;
    cachedMessage?(channelId: string, messageId: string): unknown;
    loadedMessages?(channelId: string): readonly unknown[];
}
type EventName = "MESSAGE_CREATE" | "MESSAGE_UPDATE" | "MESSAGE_DELETE" | "MESSAGE_DELETE_BULK";
const HOUR = 60 * 60_000;
function clientTime(value: unknown): unknown {
    // Gateway payloads use ISO strings; some client dispatch paths use Date/Moment objects.
    if (value && typeof value === "object" && "toISOString" in value && typeof value.toISOString === "function") return value.toISOString();
    return value;
}

export class LiveCapture {
    private grants = new Map<string, Grant>();
    private account?: string;
    private deadline = 0;
    private generation = 0;
    private queue: { grantId: string; event: LiveObservation; generation: number; bytes: number; provenance?: Provenance }[] = [];
    private queuedBytes = 0;
    private starting = false;
    private pumping = false;
    private timer?: ReturnType<typeof setTimeout>;
    private listeners = new Set<() => void>();
    private notice = "Live capture is off.";
    private saved = 0;
    constructor(private collector: Collector, private host: LiveHost, private clock = () => Date.now()) {
        collector.subscribe(() => {
            if (!collector.unlocked) { this.clear(); return; }
            if (this.grants.size) {
                const valid = new Set(collector.status().grants.filter(g => !g.revokedAt && grantExpiry(g) > this.clock()).map(g => g.grantId));
                for (const key of this.grants.keys()) {
                    if (!valid.has(key)) this.grants.delete(key);
                    else this.grants.set(key, collector.status().grants.find(g => g.grantId === key)!);
                }
                if (!this.grants.size) { this.stop("Live permissions expired or were revoked."); return; }
            }
            this.notify();
        });
    }
    subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    private notify() { for (const listener of this.listeners) listener(); }
    get active() { return this.grants.size > 0 && this.collector.unlocked && this.clock() < this.deadline; }
    status() { return { active: this.active, continuous: this.deadline === Infinity, allConversations: [...this.grants.values()].some(g => g.scope === "account"), grantIds: [...this.grants.keys()], endsAt: this.deadline && Number.isFinite(this.deadline) ? new Date(this.deadline).toISOString() : null, saved: this.saved, notice: this.notice }; }
    private clear() {
        this.generation++; this.grants.clear(); this.queue = []; this.queuedBytes = 0; this.account = undefined; this.deadline = 0;
        if (this.notice.startsWith("Capturing")) this.notice = "Live capture is off. Buffer locked.";
        clearTimeout(this.timer); this.timer = undefined; this.notify();
    }
    stop(reason = "Live capture stopped. Buffer locked.") {
        this.notice = reason; this.clear(); this.collector.lock();
    }
    checkAccount() {
        if (!this.grants.size) return;
        try {
            if (this.host.accountId() !== this.account) this.stop("Account changed. Live capture stopped and buffer locked.");
            else if (this.clock() >= this.deadline) this.stop("The one-hour live session ended. Unlock to start another session.");
        } catch { this.stop("Client state is unavailable. Live capture stopped."); }
    }
    currentDraft() {
        const accountId = this.host.accountId(); const channelId = this.host.selectedChannelId();
        const provenance = channelId && this.host.provenance(channelId);
        if (!accountId || !provenance) throw new Error("Open a supported conversation in Discord first.");
        return {
            source: "vencord-live", accountId: parseSafe(id, accountId), provenance: parseSafe(provenanceSchema, provenance),
            allowedSenderIds: provenance.kind === "dm" || provenance.kind === "group-dm"
                ? [...new Set([accountId, ...provenance.participantIds])] : [accountId],
            purpose: "Personal conversation reference", expiresAt: new Date(this.clock() + 7 * 86_400_000).toISOString(),
            retentionDays: 7, allowExport: false, principalId: "owner"
        };
    }
    allDraft(continuous = false) {
        const accountId = this.host.accountId();
        if (!accountId) throw new Error("Sign in to Discord before creating an account-wide permission.");
        return { source: "vencord-live", accountId: parseSafe(id, accountId), scope: "account", provenance: null,
            allowedSenderIds: [], purpose: "Personal conversation reference across all accessible conversations",
            continuous, expiresAt: continuous ? null : new Date(this.clock() + 7 * 86_400_000).toISOString(), retentionDays: 7,
            allowExport: false, principalId: "owner" };
    }
    async start(grantId: string, confirmed: boolean, allConfirmed = false) {
        if (this.starting) throw new Error("A live session is already starting.");
        this.starting = true;
        try { await this.startSession(grantId, confirmed, allConfirmed); } finally { this.starting = false; }
    }
    private async startSession(grantId: string, confirmed: boolean, allConfirmed: boolean) {
        this.checkAccount();
        if (confirmed !== true) throw new Error("Confirm a one-hour live session for this conversation first.");
        const account = this.host.accountId();
        const candidate = this.collector.status().grants.find(g => g.grantId === grantId);
        if (!account || !candidate) throw new Error("Unlock and select a live conversation permission first.");
        if (candidate.scope === "account" && allConfirmed !== true) throw new Error("Confirm the risk of all-conversations capture first.");
        if (this.grants.size && (candidate.scope === "account" || [...this.grants.values()].some(g => g.scope === "account")))
            throw new Error("Stop the current live session before switching to or from all conversations.");
        const provenance = candidate.provenance ? this.host.provenance(candidate.provenance.channelId) : undefined;
        if (!provenance && candidate.scope !== "account") throw new Error("Conversation is unavailable in the client. Open it first.");
        for (const g of this.grants.values()) if (g.provenance?.channelId === provenance?.channelId)
            throw new Error("This conversation is already live in this session.");
        const generation = this.generation;
        const grant = await this.collector.beginLive(grantId, account, provenance);
        if (!this.collector.unlocked || generation !== this.generation) throw new Error("Live start was cancelled.");
        if (this.host.accountId() !== account) { this.stop("Account changed. Live start cancelled."); throw new Error("Account changed."); }
        if (this.grants.size && candidate.continuous !== (this.deadline === Infinity)) throw new Error("Stop the session before changing its duration.");
        if (!this.grants.size) { this.deadline = candidate.continuous ? Infinity : this.clock() + HOUR; this.saved = 0; }
        this.account = account; this.grants.set(grantId, grant);
        this.notice = candidate.scope === "account" ? "Capturing all conversations delivered to this account." : "Capturing selected conversations delivered to this client.";
        this.schedule(); this.notify();
    }
    private schedule() {
        clearTimeout(this.timer);
        const end = Math.min(this.deadline, ...[...this.grants.values()].map(grantExpiry));
        if (!Number.isFinite(end)) return;
        this.timer = setTimeout(() => {
            this.stop("Live session or permission expired. Buffer locked.");
        }, Math.max(0, end - this.clock()));
        // Timers must not keep test/CLI processes alive; browser timers are numeric.
        if (typeof this.timer === "object") this.timer.unref?.();
    }
    loadedPreview() {
        this.checkAccount();
        if (!this.active || !this.host.loadedMessages) throw new Error("Start capture inside Discord before reviewing loaded messages.");
        const channelId = this.host.selectedChannelId();
        const grant = [...this.grants.values()].find(g => g.scope === "account" || g.provenance?.channelId === channelId);
        const provenance = channelId ? this.host.provenance(channelId) : undefined;
        if (!channelId || !grant || !provenance || !permitsProvenance(grant, provenance)) throw new Error("This conversation is outside the active permission.");
        const loaded = this.host.loadedMessages(channelId);
        if (!Array.isArray(loaded) || loaded.length > 1000) throw new Error("The loaded selection exceeds the 1,000-message limit.");
        const events: LiveObservation[] = [];
        let bytes = 0;
        for (const raw of loaded) {
            const m = raw as Record<string, any>;
            if (!m || m.deleted === true || m.channel_id !== channelId || !permitsSender(grant, m.author?.id) || m.state === "SENDING" || m.state === "SEND_FAILED" || (Number(m.flags) & 64) !== 0) continue;
            const senderName = userDisplayName(m.author);
            const event = liveObservationSchema.safeParse({ type: "snapshot", messageId: m.id, channelId, senderId: m.author?.id, ...(senderName ? { senderName } : {}),
                metadata: messageDetails(m, grant.details), createdAt: clientTime(m.timestamp), editedAt: clientTime(m.editedTimestamp ?? m.edited_timestamp ?? null), content: m.content });
            if (!event.success) continue;
            bytes += new TextEncoder().encode(JSON.stringify(event.data)).byteLength;
            if (bytes > MAX_INPUT_BYTES) throw new Error("Loaded text exceeds the 2 MiB selection limit.");
            events.push(event.data);
        }
        if (!events.length) throw new Error("No eligible loaded messages. Open a permitted conversation first.");
        return { accountId: this.account!, grantId: grant.grantId, provenance: structuredClone(provenance), events, generation: this.generation };
    }
    async captureLoaded(preview: ReturnType<LiveCapture["loadedPreview"]>, confirmed: boolean) {
        if (confirmed !== true) throw new Error("Review and confirm this loaded selection first.");
        this.checkAccount();
        if (!this.active || preview.generation !== this.generation || preview.accountId !== this.account ||
            preview.provenance.channelId !== this.host.selectedChannelId() || !this.grants.has(preview.grantId)) throw new Error("Selection changed. Review loaded messages again.");
        const observed = this.host.provenance(preview.provenance.channelId);
        const grant = this.grants.get(preview.grantId)!;
        if (!observed || !permitsProvenance(grant, observed) || JSON.stringify(observed) !== JSON.stringify(preview.provenance)) throw new Error("Conversation scope changed. Review again.");
        // Queue reviewed snapshots with live events to preserve observed delete/edit ordering.
        if (this.queue.length + preview.events.length > 1000) throw new Error("Capture queue is busy. Retry after it drains.");
        const items = preview.events.map(raw => {
            const event = parseSafe(liveObservationSchema, raw);
            if (event.type !== "snapshot" || event.channelId !== observed.channelId) throw new Error("Invalid loaded selection.");
            return { grantId: grant.grantId, event, generation: this.generation, bytes: new TextEncoder().encode(JSON.stringify(event)).byteLength, provenance: observed };
        });
        if (items.reduce((n, i) => n + i.bytes, this.queuedBytes) > MAX_INPUT_BYTES) throw new Error("Capture queue is full. Retry after it drains.");
        this.queue.push(...items); this.queuedBytes += items.reduce((n, i) => n + i.bytes, 0);
        void this.pump(); await this.drained();
        if (!this.active) throw new Error("Capture stopped before the selection completed. Some snapshots may be missing.");
        return items.length;
    }
    refreshDetails(payload: unknown) {
        if (!this.active || !payload || typeof payload !== "object") return;
        const p = payload as Record<string, unknown>;
        const channelId = p.channelId ?? p.channel_id, messageId = p.messageId ?? p.message_id;
        if (typeof channelId !== "string" || typeof messageId !== "string") return;
        const generation = this.generation;
        queueMicrotask(() => {
            if (!this.active || generation !== this.generation) return;
            const grant = [...this.grants.values()].find(g => g.scope === "account" || g.provenance?.channelId === channelId);
            if (!grant?.details.length) return;
            const m = this.host.cachedMessage?.(channelId, messageId) as Record<string, unknown> | undefined;
            if (!m || m.deleted === true || (Number(m.flags) & 64) !== 0) return;
            this.receive("MESSAGE_UPDATE", { message: { id: messageId, channel_id: channelId, __details: messageDetails(m, grant.details) } });
        });
    }
    pollDetails() {
        this.checkAccount();
        if (!this.active || !this.host.loadedMessages) return;
        const channelId = this.host.selectedChannelId();
        if (!channelId) return;
        const grant = [...this.grants.values()].find(g => g.scope === "account" || g.provenance?.channelId === channelId);
        if (!grant?.details.length) return;
        // Only update already-collected records; never backfill unseen messages automatically.
        for (const raw of this.host.loadedMessages(channelId).slice(-100)) {
            const m = raw as Record<string, unknown>;
            if (!m || m.deleted === true || m.channel_id !== channelId || (Number(m.flags) & 64) !== 0) continue;
            this.receive("MESSAGE_UPDATE", { message: { id: m.id, channel_id: channelId,
                ...messageDetails(m, grant.details) && { __details: messageDetails(m, grant.details) } } });
        }
    }
    receive(name: EventName, payload: unknown) {
        this.checkAccount();
        if (!this.active) return;
        try {
            const p = payload as Record<string, any>;
            if (!p || typeof p !== "object" || p.optimistic === true) return;
            const m = p.message as Record<string, any> | undefined;
            const channelId = name === "MESSAGE_CREATE" || name === "MESSAGE_UPDATE" ? m?.channel_id : p.channelId ?? p.channel_id;
            if (typeof channelId !== "string") return;
            const grant = [...this.grants.values()].find(g => g.scope === "account" || g.provenance?.channelId === channelId);
            if (!grant) return; // Never copy or parse content outside an explicitly started conversation.
            if (grantExpiry(grant) <= this.clock()) { this.stop("Live permission expired."); return; }
            const observed = this.host.provenance(channelId);
            if (observed && !permitsProvenance(grant, observed)) { this.stop("Conversation membership or scope changed. Review a new permission."); return; }
            // Unsupported/unavailable channels cannot be attributed safely; account mode skips them.
            if (!observed && grant.scope === "account" && (name === "MESSAGE_CREATE" || name === "MESSAGE_UPDATE")) return;
            if (!observed && (name === "MESSAGE_CREATE" || name === "MESSAGE_UPDATE")) { this.stop("Conversation access is unavailable. Capture stopped."); return; }
            const events: unknown[] = [];
            if (name === "MESSAGE_CREATE") {
                if (!m || typeof m.author?.id !== "string" || !permitsSender(grant, m.author.id)) return;
                // Ignore unsent/failed local echoes and ephemeral messages, even if optimistic is absent.
                if (m.state === "SENDING" || m.state === "SEND_FAILED" || (Number(m.flags) & 64) !== 0) return;
                const senderName = userDisplayName(m.author);
                events.push({ type: "create", channelId, messageId: m.id, senderId: m.author.id, ...(senderName ? { senderName } : {}), metadata: messageDetails(m, grant.details), createdAt: clientTime(m.timestamp), content: m.content });
            } else if (name === "MESSAGE_UPDATE") {
                if (!m) return;
                events.push({ type: "update", channelId, messageId: m.id, metadata: m.__details ?? messageDetails(m, grant.details),
                    ...(m.author?.id !== undefined ? { senderId: m.author.id } : {}),
                    ...(userDisplayName(m.author) ? { senderName: userDisplayName(m.author) } : {}),
                    ...(m.content !== undefined ? { content: m.content } : {}),
                    ...(m.edited_timestamp !== undefined ? { editedAt: clientTime(m.edited_timestamp) } : {}) });
            } else {
                const ids = name === "MESSAGE_DELETE_BULK" ? p.ids : [p.id];
                if (!Array.isArray(ids) || ids.length > 1000) throw new Error();
                for (const messageId of ids) events.push({ type: "delete", channelId, messageId });
            }
            if (this.queue.length + events.length > 1000) { this.stop("Live queue filled. Capture stopped; some events were not saved."); return; }
            for (const raw of events) {
                const event = parseSafe(liveObservationSchema, raw);
                const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
                if (this.queuedBytes + bytes > MAX_INPUT_BYTES) { this.stop("Live queue filled. Capture stopped; some events were not saved."); return; }
                this.queue.push({ grantId: grant.grantId, event, generation: this.generation, bytes, provenance: observed ? structuredClone(observed) : undefined }); this.queuedBytes += bytes;
            }
            void this.pump();
        } catch { this.stop("Unexpected client event. Capture stopped; review compatibility before restarting."); }
    }
    private async pump() {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (this.queue.length && this.active) {
                this.checkAccount(); if (!this.active) break;
                const item = this.queue.shift()!;
                this.queuedBytes -= item.bytes;
                if (item.generation !== this.generation || !this.grants.has(item.grantId)) continue;
                const account = this.account!;
                const saved = await this.collector.captureLive(item.grantId, account, item.event, item.provenance);
                if (item.generation === this.generation && saved) { this.saved++; this.notify(); }
            }
        } catch { if (this.grants.size) this.stop("Live capture could not save safely. Buffer locked; unlock to inspect storage or permissions. Some events may be missing."); }
        finally { this.pumping = false; }
    }
    async drained() { while (this.pumping) await new Promise(resolve => setTimeout(resolve, 1)); }
}

/** Read only currently available channel metadata. No history/API requests or account credentials. */
/** The name Discord shows for a user: global display name, else username. Never invents one. */
export function userDisplayName(user: unknown): string | undefined {
    if (!user || typeof user !== "object") return undefined;
    const u = user as Record<string, unknown>;
    for (const v of [u.globalName, u.global_name, u.username]) if (typeof v === "string" && v.trim()) return v.trim().slice(0, 100);
    return undefined;
}
export function channelProvenance(channel: unknown, accountId: string, guildName: string | null = null,
    nameOf: (userId: string) => string | undefined = () => undefined): Provenance | undefined {
    if (!channel || typeof channel !== "object") return undefined;
    const c = channel as Record<string, any>;
    const kind = c.type === 1 ? "dm" : c.type === 3 ? "group-dm" : [10, 11, 12].includes(c.type) ? "guild-thread" : [0, 2, 5, 13].includes(c.type) ? "guild-channel" : undefined;
    if (!kind) return undefined;
    const dm = kind === "dm" || kind === "group-dm";
    const result = provenanceSchema.safeParse({ kind, guildId: dm ? null : c.guild_id ?? null, guildName: dm ? null : guildName,
        channelId: c.id,
        // DMs have no channel name; label them the way Discord does, by the other people's names.
        channelName: typeof c.name === "string" && c.name ? c.name.slice(0, 200)
            : dm ? (Array.isArray(c.recipients) ? c.recipients : []).filter((r: unknown) => typeof r === "string" && r !== accountId)
                .map((r: string) => nameOf(r)).filter(Boolean).join(", ").slice(0, 200) || null : null,
        parentChannelId: kind === "guild-thread" ? c.parent_id ?? null : null,
        threadId: kind === "guild-thread" ? c.id : null,
        participantIds: dm ? [...new Set([accountId, ...(Array.isArray(c.recipients) ? c.recipients : [])])].sort() : [] });
    return result.success ? result.data : undefined;
}
