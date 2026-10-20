import type { Collector } from "./collector";
import type { LiveCapture } from "./live";
import { activityObservationSchema, permitsActivity, type ActivityObservation } from "./activity-schema";

export interface ActivityHost {
    accountId(): string | undefined;
    scheduledEvents(guildId: string): readonly unknown[] | undefined;
    presence(userId: string): unknown; // undefined means not observed, never presumed offline
    voice(guildId: string, userId: string): string | null | undefined;
    guildForChannel?(channelId: string): string | undefined;
}
type Voice = { channel: string | null; since: number };
export class ActivityCapture {
    private generation = 0;
    private signature = "";
    private schedules = new Map<string, string>();
    private presences = new Map<string, string>();
    private voices = new Map<string, Voice>();
    private queue: { grantId: string; accountId: string; event: ActivityObservation; generation: number; bytes: number }[] = [];
    private bytes = 0;
    private pumping = false;
    private connected = true;
    private lastPoll = 0;
    constructor(private collector: Collector, private live: LiveCapture, private host: ActivityHost, private clock = () => Date.now()) {
        live.subscribe(() => { if (!live.active) this.reset(); });
    }
    reset() {
        this.generation++; this.signature = ""; this.schedules.clear(); this.presences.clear(); this.voices.clear();
        this.queue = []; this.bytes = 0; this.lastPoll = 0;
    }
    connection(connected: boolean) { this.reset(); this.connected = connected; }
    private permission() {
        this.live.checkAccount();
        if (!this.connected || !this.live.active) { this.reset(); return; }
        const ids = this.live.status().grantIds;
        const grant = this.collector.status().grants.find(g => ids.includes(g.grantId) && g.scope === "account" && g.accountId === this.host.accountId());
        if (!grant) { this.reset(); return; }
        const signature = grant.grantId + JSON.stringify(grant.activity);
        if (signature !== this.signature) { this.reset(); this.signature = signature; }
        return grant;
    }
    poll() {
        const grant = this.permission();
        if (!grant || this.clock() - this.lastPoll < 5000) return;
        // A long stall/sleep is an observation gap, so do not bridge voice durations across it.
        if (this.lastPoll && this.clock() - this.lastPoll > 15_000) { this.reset(); this.signature = grant.grantId + JSON.stringify(grant.activity); }
        this.lastPoll = this.clock();
        const p = grant.activity;
        try {
            if (p.scheduledEvents) {
                let scanned = 0;
                for (const guildId of p.guildIds) {
                    const events = this.host.scheduledEvents(guildId);
                    if (!events) continue;
                    for (const raw of events) {
                        if (++scanned > 1000) throw new Error("Too many cached events.");
                        const o = scheduledSnapshot(raw);
                        if (!o || o.guildId !== guildId) continue;
                        const key = guildId + ":" + o.scheduledEventId, value = JSON.stringify(o);
                        if (this.schedules.get(key) === value) continue;
                        // Bound deduplication memory too; missing entries are not deletions.
                        if (this.schedules.size >= 1000 && !this.schedules.has(key)) this.schedules.delete(this.schedules.keys().next().value!);
                        this.enqueue(grant.grantId, grant.accountId, o); this.schedules.set(key, value);
                    }
                }
            }
            if (p.presence) for (const userId of p.userIds) {
                const status = this.host.presence(userId);
                if (!["online", "idle", "dnd", "offline"].includes(status as string)) { this.presences.delete(userId); continue; }
                if (this.presences.get(userId) === status) continue;
                const event = activityObservationSchema.parse({ type: "presence.observed", userId, status, previousStatus: this.presences.get(userId) ?? null });
                this.enqueue(grant.grantId, grant.accountId, event); this.presences.set(userId, status as string);
            }
            // Seed only actual cached occupants. Absence does not prove a leave or an empty channel.
            if (p.voice) for (const guildId of p.guildIds) for (const userId of p.userIds) {
                const channel = this.host.voice(guildId, userId), key = guildId + ":" + userId;
                if (typeof channel !== "string") { this.voices.delete(key); continue; }
                const previous = this.voices.get(key);
                if (previous?.channel === channel) continue;
                this.voices.set(key, { channel, since: this.clock() });
                this.enqueue(grant.grantId, grant.accountId, { type: "voice.observed", guildId, userId, channelId: channel,
                    previousChannelId: null, observation: "baseline", previousChannelObservedSince: null, observedDurationSeconds: null });
            }
        } catch { this.live.stop("Activity cache could not be read safely. Capture stopped; review client compatibility."); }
    }
    voiceUpdates(payload: unknown) {
        const grant = this.permission();
        if (!grant?.activity.voice) return;
        if (this.lastPoll && this.clock() - this.lastPoll > 15_000) this.voices.clear();
        const states = (payload as any)?.voiceStates;
        if (!Array.isArray(states) || states.length > 1000) return;
        try {
            for (const s of states) {
                if (!s || !grant.activity.userIds.includes(s.userId)) continue;
                const old = typeof s.oldChannelId === "string" ? s.oldChannelId : null;
                // Client Flux events can omit guildId and use undefined for a leave.
                const channel = typeof s.channelId === "string" ? s.channelId : null;
                if (!channel && !old) continue;
                const guildId = this.host.guildForChannel?.(channel ?? old!) ?? s.guildId;
                if (!grant.activity.guildIds.includes(guildId)) continue;
                const key = guildId + ":" + s.userId, previous = this.voices.get(key);
                if (previous?.channel === channel) continue;
                const continuous = previous?.channel != null && previous.channel === old;
                this.enqueue(grant.grantId, grant.accountId, { type: "voice.observed", guildId, userId: s.userId,
                    channelId: channel, previousChannelId: old, observation: "transition",
                    previousChannelObservedSince: continuous ? new Date(previous.since).toISOString() : null,
                    observedDurationSeconds: continuous ? Math.max(0, (this.clock() - previous.since) / 1000) : null });
                this.voices.set(key, { channel, since: this.clock() });
            }
        } catch { this.live.stop("Unexpected voice observation. Capture stopped."); }
    }
    private enqueue(grantId: string, accountId: string, raw: ActivityObservation) {
        const event = activityObservationSchema.parse(raw);
        const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
        if (this.queue.length >= 250 || this.bytes + bytes > 512 * 1024) throw new Error("Activity queue is full.");
        this.queue.push({ grantId, accountId, event, generation: this.generation, bytes }); this.bytes += bytes;
        void this.pump();
    }
    private async pump() {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (this.queue.length) {
                const grant = this.permission(); if (!grant) break;
                const item = this.queue.shift(); if (!item) break;
                this.bytes -= item.bytes;
                if (item.generation !== this.generation || item.grantId !== grant.grantId || !permitsActivity(grant.activity, item.event)) continue;
                await this.collector.captureActivity(item.grantId, item.accountId, item.event);
            }
        } catch { if (this.live.active) this.live.stop("Activity could not be saved safely. Collection paused; some observations may be missing."); }
        finally { this.pumping = false; }
    }
    async drained() { while (this.pumping) await new Promise(resolve => setTimeout(resolve, 1)); }
}

export function scheduledSnapshot(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const e = raw as Record<string, any>, r = e.recurrence_rule;
    const result = activityObservationSchema.safeParse({ type: "scheduled-event.snapshot", guildId: e.guild_id,
        scheduledEventId: e.id, channelId: e.channel_id ?? null, creatorId: e.creator_id ?? null,
        name: e.name, description: e.description ?? null, startsAt: e.scheduled_start_time, endsAt: e.scheduled_end_time ?? null,
        status: ({ 1: "scheduled", 2: "active", 3: "completed", 4: "cancelled" } as Record<number, string>)[e.status],
        location: e.entity_metadata?.location ?? null,
        recurrence: r ? { start: r.start, end: r.end ?? null, frequency: r.frequency, interval: r.interval,
            byWeekday: r.byWeekday ?? r.by_weekday ?? null, byNWeekday: r.byNWeekday ?? r.by_n_weekday ?? null,
            byMonth: r.byMonth ?? r.by_month ?? null, byMonthDay: r.byMonthDay ?? r.by_month_day ?? null,
            byYearDay: r.byYearDay ?? r.by_year_day ?? null, count: r.count ?? null } : null,
        recurrenceExceptionsUnresolved: !!r || !!e.guild_scheduled_event_exceptions?.length });
    return result.success && result.data.type === "scheduled-event.snapshot" ? result.data : undefined;
}
