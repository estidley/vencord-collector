import { Collector } from "./collector";
import { LiveCapture } from "./live";
import { autoConfigSchema, type AutoProtection, type AutoStorage } from "./auto-config";
import { parseSafe } from "./schema";
import { syncSetupSchema, type SyncSetup } from "./sync-config";
import type { SyncController } from "./sync";

// If capture stops underneath a running always-on session (a fail-closed stop such as an unexpected client
// event or a save error), resume it in-session with backoff instead of waiting for the next Discord restart.
// Resuming re-runs exactly the restart-time checks: same account, same saved grant, continuous and not revoked.
export const RESUME_DELAY = 60_000, MAX_RESUME_DELAY = 15 * 60_000, RESUME_RESET = 60 * 60_000;

/** No plaintext credential is retained on this controller or placed in settings. */
export class AlwaysOn {
    private running = false;
    private generation = 0;
    private attempted?: string;
    private enabled = false;
    private busy = false;
    private pending: Promise<unknown> = Promise.resolve();
    private notice = "Always-on collection is off.";
    private listeners = new Set<() => void>();
    private runningGrant?: string;
    private resumeAt = 0;
    private resumes = 0;
    private startedAt = 0;
    constructor(private collector: Collector, private live: LiveCapture, private storage: AutoStorage,
        private protection: () => AutoProtection | undefined, private accountId: () => string | undefined,
        private sync?: SyncController, private clock = () => Date.now()) {}
    /** The continuous grant currently being collected, for receiver sync. */
    get grantId() { return this.enabled && this.live.active ? this.runningGrant : undefined; }
    subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
    private notify() { for (const fn of this.listeners) fn(); }
    status() { return { enabled: this.enabled, busy: this.busy, notice: this.notice, resumeAt: this.resumeAt || null }; }
    private serial<T>(fn: () => Promise<T>) { const task = this.pending.then(fn); this.pending = task.catch(() => {}); return task; }
    private check(generation: number, account: string) {
        if (!this.running || generation !== this.generation || this.accountId() !== account) throw new Error("Automatic collection was cancelled or the account changed.");
    }
    activate() { this.running = true; this.attempted = undefined; this.resumeAt = 0; this.resumes = 0; }
    shutdown() { this.resumeAt = 0; this.running = false; this.generation++; this.enabled = false; this.runningGrant = undefined; this.live.stop(); this.notify(); }
    accountChanged() { this.resumeAt = 0; this.generation++; this.attempted = undefined; this.enabled = false; this.runningGrant = undefined; this.live.stop("Account changed or logged out. Collection paused."); this.notify(); }
    async disable() {
        this.generation++; this.resumeAt = 0; this.enabled = false; this.runningGrant = undefined; this.attempted = this.accountId(); this.live.stop(); this.notify();
        return this.serial(async () => {
            try {
                await this.storage.writeAuto(undefined); await this.sync?.disarm();
                this.notice = "Always-on disabled. Remembered passphrase and sync settings removed; buffer locked.";
            }
            catch { this.notice = "Buffer locked, but automatic-unlock removal failed. Disable the plugin before restarting Discord and retry removal."; throw new Error(this.notice); }
            finally { this.notify(); }
        });
    }
    async enable(passphrase: string, authority: boolean, risk: boolean, syncSetup?: SyncSetup) {
        if (!authority || !risk) throw new Error("Confirm authority and the always-on privacy risks first.");
        const setup = syncSetup ? parseSafe(syncSetupSchema, syncSetup) : undefined;
        if (setup && !this.sync) throw new Error("Receiver sync is not available in this build.");
        if (this.busy) throw new Error("Automatic collection is already being prepared.");
        if (this.live.active) throw new Error("Stop the current live session before enabling always-on collection.");
        const account = this.accountId(); if (!account) throw new Error("Sign in to Discord first.");
        const generation = this.generation;
        this.busy = true; this.notify();
        return this.serial(async () => {
            try {
                this.check(generation, account);
                const native = this.protection();
                if (!native || !await native.available()) throw new Error("Always-on requires Discord Desktop on Windows with operating-system encryption available.");
                await this.collector.verifyPassphrase(passphrase); this.check(generation, account);
                // Sync needs its own export-enabled grant naming the receiver's importer; permissions are immutable.
                const draft = setup ? { ...this.live.allDraft(true), allowExport: true, principalId: setup.principalId } : this.live.allDraft(true);
                const grant = await this.collector.grant(draft, true); this.check(generation, account);
                if (setup) await this.sync!.arm(setup, account, grant.grantId); else await this.sync?.disarm();
                this.check(generation, account);
                const encrypted = await native.protect({ version: 1, accountId: account, grantId: grant.grantId, passphrase });
                this.check(generation, account); await this.storage.writeAuto(encrypted); this.check(generation, account);
                await this.live.start(grant.grantId, true, true); this.check(generation, account);
                this.enabled = true; this.runningGrant = grant.grantId; this.attempted = account; this.startedAt = this.clock(); this.resumes = 0;
                this.notice = setup ? "Always-on enabled with receiver sync. Collection and sync resume whenever Discord opens."
                    : "Always-on enabled. Collection resumes for this account whenever Discord opens.";
            } catch (error) {
                // Never leave a newly saved credential armed after a failed enable operation.
                // Keep the reason visible: stopping live capture locks the buffer and replaces the panel message.
                this.notice = `Automatic collection was not started. ${error instanceof Error ? error.message : ""}`.trim();
                this.enabled = false; this.runningGrant = undefined; this.live.stop();
                try { await this.storage.writeAuto(undefined); await this.sync?.disarm(); }
                catch { this.notice = "Setup stopped, but saved-credential removal failed. Disable the plugin before restarting Discord and retry removal."; throw new Error(this.notice); }
                throw error;
            } finally { this.busy = false; this.notify(); }
        });
    }
    async restore() {
        const account = this.accountId();
        if (!this.running || !account || this.busy || this.live.active) return;
        if (this.attempted === account) {
            // Only a session that was running for this account and then stopped underneath us is resumed.
            // Disable, account change, shutdown and a failed restore all clear enabled, so they never retry here.
            if (!this.enabled || this.runningGrant === undefined) return;
            const now = this.clock();
            if (!this.resumeAt) {
                if (this.startedAt && now - this.startedAt >= RESUME_RESET) this.resumes = 0;
                this.resumeAt = now + Math.min(MAX_RESUME_DELAY, RESUME_DELAY * 2 ** this.resumes);
                const reason = this.live.status().notice;
                this.notice = `Collection stopped (${reason}). Resuming automatically at ${new Date(this.resumeAt).toLocaleTimeString()}.`;
                try { console.warn("[MessageCollector] capture stopped; scheduling automatic resume:", reason); } catch {}
                this.notify(); return;
            }
            if (now < this.resumeAt) return;
            this.resumeAt = 0; this.resumes++;
        }
        this.attempted = account;
        const generation = this.generation;
        this.busy = true; this.notify();
        return this.serial(async () => {
            try {
                this.check(generation, account);
                const encrypted = await this.storage.readAuto(); if (!encrypted) return;
                const native = this.protection();
                if (!native || !await native.available()) throw new Error();
                const value = await native.restore(encrypted, account); this.check(generation, account);
                if (!value) { this.notice = "Always-on is saved for another Discord account. This account is not collected."; return; }
                const config = parseSafe(autoConfigSchema, value);
                if (config.accountId !== account) throw new Error();
                await this.collector.unlock(config.passphrase); this.check(generation, account);
                const grant = this.collector.status().grants.find(g => g.grantId === config.grantId);
                if (!grant?.continuous || grant.revokedAt || grant.accountId !== account) throw new Error();
                await this.live.start(grant.grantId, true, true); this.check(generation, account);
                this.enabled = true; this.runningGrant = grant.grantId; this.startedAt = this.clock();
                this.notice = grant.allowExport ? "Always-on restored with receiver sync. Collecting while Discord is open."
                    : "Always-on restored. Collecting while Discord is open.";
            } catch {
                try { console.warn("[MessageCollector] automatic collection could not resume"); } catch {}
                if (generation === this.generation) { this.live.stop(); this.enabled = false; this.runningGrant = undefined; this.notice = "Automatic collection could not resume. Unlock and review the buffer, or disable always-on and enable it again."; }
            } finally { this.busy = false; this.notify(); }
        });
    }
}
