import { Collector } from "./collector";
import { LiveCapture } from "./live";
import { autoConfigSchema, type AutoProtection, type AutoStorage } from "./auto-config";
import { parseSafe } from "./schema";

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
    constructor(private collector: Collector, private live: LiveCapture, private storage: AutoStorage,
        private protection: () => AutoProtection | undefined, private accountId: () => string | undefined) {}
    subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
    private notify() { for (const fn of this.listeners) fn(); }
    status() { return { enabled: this.enabled, busy: this.busy, notice: this.notice }; }
    private serial<T>(fn: () => Promise<T>) { const task = this.pending.then(fn); this.pending = task.catch(() => {}); return task; }
    private check(generation: number, account: string) {
        if (!this.running || generation !== this.generation || this.accountId() !== account) throw new Error("Automatic collection was cancelled or the account changed.");
    }
    activate() { this.running = true; this.attempted = undefined; }
    shutdown() { this.running = false; this.generation++; this.enabled = false; this.live.stop(); this.notify(); }
    accountChanged() { this.generation++; this.attempted = undefined; this.enabled = false; this.live.stop("Account changed or logged out. Collection paused."); this.notify(); }
    async disable() {
        this.generation++; this.enabled = false; this.attempted = this.accountId(); this.live.stop(); this.notify();
        return this.serial(async () => {
            try { await this.storage.writeAuto(undefined); this.notice = "Always-on disabled. Remembered passphrase removed; buffer locked."; }
            catch { this.notice = "Buffer locked, but automatic-unlock removal failed. Disable the plugin before restarting Discord and retry removal."; throw new Error(this.notice); }
            finally { this.notify(); }
        });
    }
    async enable(passphrase: string, authority: boolean, risk: boolean) {
        if (!authority || !risk) throw new Error("Confirm authority and the always-on privacy risks first.");
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
                const grant = await this.collector.grant(this.live.allDraft(true), true); this.check(generation, account);
                const encrypted = await native.protect({ version: 1, accountId: account, grantId: grant.grantId, passphrase });
                this.check(generation, account); await this.storage.writeAuto(encrypted); this.check(generation, account);
                await this.live.start(grant.grantId, true, true); this.check(generation, account);
                this.enabled = true; this.attempted = account; this.notice = "Always-on enabled. Collection resumes for this account whenever Discord opens.";
            } catch (error) {
                // Never leave a newly saved credential armed after a failed enable operation.
                this.enabled = false; this.live.stop();
                try { await this.storage.writeAuto(undefined); }
                catch { this.notice = "Setup stopped, but saved-credential removal failed. Disable the plugin before restarting Discord and retry removal."; throw new Error(this.notice); }
                throw error;
            } finally { this.busy = false; this.notify(); }
        });
    }
    async restore() {
        const account = this.accountId();
        if (!this.running || !account || this.busy || this.attempted === account || this.live.active) return;
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
                this.enabled = true; this.notice = "Always-on restored. Collecting while Discord is open.";
            } catch {
                if (generation === this.generation) { this.live.stop(); this.enabled = false; this.notice = "Automatic collection could not resume. Unlock and review the buffer, or disable always-on and enable it again."; }
            } finally { this.busy = false; this.notify(); }
        });
    }
}
