import { z } from "zod";
import { id, instant } from "./schema";

/** What the user supplies once. The receiver token is pasted from its `<principal>.secret` file. */
export const syncSetupSchema = z.strictObject({
    principalId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
    port: z.number().int().min(1024).max(65535),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});
export type SyncSetup = z.infer<typeof syncSetupSchema>;
/** Protected by the OS and only ever decrypted in the native (Electron main) process. */
export const syncConfigSchema = syncSetupSchema.safeExtend({
    version: z.literal(1), accountId: id, grantId: z.uuid(),
    // Generated natively; never shown to the user or the renderer.
    transferPassphrase: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});
export type SyncConfig = z.infer<typeof syncConfigSchema>;
export const receiptSchema = z.object({
    version: z.literal(1), receiptId: z.uuid(), checkpoint: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative(), committedAt: instant
});
export type Receipt = z.infer<typeof receiptSchema>;
/**
 * retry: network/429/5xx, resend later. credentials: 401, token rejected. refused: 400/403/409/413,
 * the receiver will not take this batch as-is (scope, revocation, identity conflict, size).
 */
export type Failure = { ok: false; kind: "retry" | "credentials" | "refused"; status: number };
export type Delivery = { ok: true; receipt: Receipt } | Failure;
export type Probe = { ok: true; checkpoint: number } | Failure;
export function classify(status: number): Failure["kind"] {
    if (status === 401) return "credentials";
    if (status === 0 || status === 429 || status >= 500) return "retry";
    return "refused";
}
export interface SyncNative {
    available(): Promise<boolean>;
    /** Returns OS-protected ciphertext for the full config, with a freshly generated transfer passphrase. */
    protectSync(setup: SyncSetup & { accountId: string; grantId: string }): Promise<string>;
    /** Authenticated checkpoint request; proves the port and token before collection is armed. */
    probeSync(ciphertext: string, accountId: string): Promise<Probe>;
    deliver(ciphertext: string, accountId: string, batch: unknown): Promise<Delivery>;
}
export interface SyncStorage {
    readSync(): Promise<string | undefined>;
    writeSync(ciphertext: string | undefined): Promise<void>;
}
