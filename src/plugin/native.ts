// SPDX-License-Identifier: GPL-3.0-or-later
import { safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { autoConfigSchema, type AutoConfig } from "../core/auto-config";
import { derive, seal, type Secret } from "../core/crypto";
import { batchSchema, id, parseSafe } from "../core/schema";
import { classify, receiptSchema, syncConfigSchema, syncSetupSchema, type Delivery, type Probe, type SyncConfig } from "../core/sync-config";

// Native code protects credentials and, only when sync is configured, delivers sealed batches to the
// personal-coordination-mcp receiver on 127.0.0.1. IndexedDB owns persistence. No file paths, no other hosts.
export function available() { return process.platform === "win32" && safeStorage.isEncryptionAvailable(); }
function protectJson(value: unknown, failure: string): string {
    if (!available()) throw new Error("Windows credential protection is unavailable.");
    try { return safeStorage.encryptString(JSON.stringify(value)).toString("base64"); }
    catch { throw new Error(failure); }
}
function restoreJson(ciphertext: string, failure: string): unknown {
    if (!available()) throw new Error("Windows credential protection is unavailable.");
    if (typeof ciphertext !== "string" || ciphertext.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) throw new Error("Invalid protected credential.");
    try { return JSON.parse(safeStorage.decryptString(Buffer.from(ciphertext, "base64"))); }
    catch { throw new Error(failure); }
}
export function protect(_event: unknown, input: AutoConfig): string {
    const config = parseSafe(autoConfigSchema, input);
    return protectJson(config, "Unable to protect automatic-unlock settings.");
}
export function restore(_event: unknown, ciphertext: string, accountId: string): AutoConfig | undefined {
    parseSafe(id, accountId);
    const value = restoreJson(ciphertext, "Unable to unlock remembered settings on this Windows account.");
    const config = parseSafe(autoConfigSchema, value);
    return config.accountId === accountId ? config : undefined;
}

// ---- Receiver sync. The token and transfer passphrase never leave this process in plaintext. ----
export function protectSync(_event: unknown, input: unknown): string {
    const { accountId, grantId, ...setup } = (input ?? {}) as Record<string, unknown>;
    const config: SyncConfig = parseSafe(syncConfigSchema, { ...parseSafe(syncSetupSchema, setup), version: 1, accountId, grantId,
        transferPassphrase: randomBytes(32).toString("base64url") });
    return protectJson(config, "Unable to protect sync settings.");
}
function openSync(ciphertext: string, accountId: string): SyncConfig {
    parseSafe(id, accountId);
    const config = parseSafe(syncConfigSchema, restoreJson(ciphertext, "Unable to unlock sync settings on this Windows account."));
    if (config.accountId !== accountId) throw new Error("Sync settings belong to another Discord account.");
    return config;
}
// PBKDF2 (600,000 iterations) once per configuration per Discord session, not once per batch.
// A fresh IV is still generated for every sealed batch.
let cachedKey: { ciphertext: string; secret: Promise<Secret> } | undefined;
function transferKey(ciphertext: string, config: SyncConfig) {
    if (cachedKey?.ciphertext !== ciphertext) cachedKey = { ciphertext, secret: derive(config.transferPassphrase) };
    return cachedKey.secret;
}
const MAX_BODY = 12 * 1024 * 1024;
async function call(config: SyncConfig, path: string, body?: string): Promise<{ status: number; json?: unknown }> {
    try {
        const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
            method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
            headers: { Authorization: `Bearer ${config.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body });
        const text = await response.text();
        if (!response.ok || text.length > 64 * 1024) return { status: response.ok ? 502 : response.status };
        return { status: response.status, json: JSON.parse(text) };
    } catch { return { status: 0 }; } // Never surface request details, which include the token.
}
export async function probeSync(_event: unknown, ciphertext: string, accountId: string): Promise<Probe> {
    const config = openSync(ciphertext, accountId);
    const { status, json } = await call(config, `/v1/checkpoint?accountId=${encodeURIComponent(accountId)}`);
    const checkpoint = (json as { version?: unknown; checkpoint?: unknown } | undefined);
    if (status === 200 && checkpoint?.version === 1 && Number.isInteger(checkpoint.checkpoint)) return { ok: true, checkpoint: checkpoint.checkpoint as number };
    const failed = status === 200 ? 502 : status;
    return { ok: false, kind: classify(failed), status: failed };
}
export async function deliver(_event: unknown, ciphertext: string, accountId: string, input: unknown): Promise<Delivery> {
    const config = openSync(ciphertext, accountId);
    const batch = parseSafe(batchSchema, input);
    // The renderer can only ask to deliver batches for the one configured grant, importer and account.
    if (batch.grant.grantId !== config.grantId || batch.grant.accountId !== accountId || !batch.grant.allowExport ||
        batch.principalId !== config.principalId || batch.grant.principalId !== config.principalId ||
        batch.events.some(e => e.grantId !== config.grantId || e.accountId !== accountId))
        throw new Error("Batch does not match the configured sync permission.");
    const envelope = await seal(batch, await transferKey(ciphertext, config), "coordination-batch/v1");
    const body = JSON.stringify({ version: 1, envelope, transferPassphrase: config.transferPassphrase });
    if (body.length > MAX_BODY) return { ok: false, kind: "refused", status: 413 };
    const { status, json } = await call(config, "/v1/ingest", body);
    if (status === 200) {
        const receipt = receiptSchema.safeParse(json);
        if (receipt.success) return { ok: true, receipt: receipt.data };
        return { ok: false, kind: "retry", status: 502 };
    }
    return { ok: false, kind: classify(status), status };
}
