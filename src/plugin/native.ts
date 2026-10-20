// SPDX-License-Identifier: GPL-3.0-or-later
import { safeStorage } from "electron";
import { autoConfigSchema, type AutoConfig } from "../core/auto-config";
import { id, parseSafe } from "../core/schema";

// Native code only protects credentials; IndexedDB owns persistence. No file/network API is exposed.
export function available() { return process.platform === "win32" && safeStorage.isEncryptionAvailable(); }
export function protect(_event: unknown, input: AutoConfig): string {
    if (!available()) throw new Error("Windows credential protection is unavailable.");
    const config = parseSafe(autoConfigSchema, input);
    try { return safeStorage.encryptString(JSON.stringify(config)).toString("base64"); }
    catch { throw new Error("Unable to protect automatic-unlock settings."); }
}
export function restore(_event: unknown, ciphertext: string, accountId: string): AutoConfig | undefined {
    if (!available()) throw new Error("Windows credential protection is unavailable.");
    parseSafe(id, accountId);
    if (typeof ciphertext !== "string" || ciphertext.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) throw new Error("Invalid protected credential.");
    try {
        const config = parseSafe(autoConfigSchema, JSON.parse(safeStorage.decryptString(Buffer.from(ciphertext, "base64"))));
        return config.accountId === accountId ? config : undefined;
    } catch { throw new Error("Unable to unlock remembered settings on this Windows account."); }
}
