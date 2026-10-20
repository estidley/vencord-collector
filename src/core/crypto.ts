import { z } from "zod";
import { MAX_VAULT_BYTES, parseSafe } from "./schema";

const ITERATIONS = 600_000;
const contextSchema = z.enum(["collector-vault/v1", "coordination-batch/v1"]);
const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
export const envelopeSchema = z.strictObject({
    version: z.literal(1), context: contextSchema,
    kdf: z.literal("PBKDF2-SHA256"), iterations: z.literal(ITERATIONS),
    cipher: z.literal("AES-256-GCM"), salt: b64.length(24), iv: b64.length(16),
    ciphertext: b64.min(24).max(12 * 1024 * 1024)
});
export type Envelope = z.infer<typeof envelopeSchema>;
export type Context = z.infer<typeof contextSchema>;
export type Secret = { key: CryptoKey; salt: string };
const utf8 = new TextEncoder();
const encode = (bytes: Uint8Array) => {
    let s = "";
    for (const n of bytes) s += String.fromCharCode(n);
    return btoa(s);
};
const decode = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const aad = (context: Context, salt: string) => utf8.encode(`${context}|1|PBKDF2-SHA256|${ITERATIONS}|AES-256-GCM|${salt}`);

export async function derive(passphrase: string, salt = encode(crypto.getRandomValues(new Uint8Array(16)))): Promise<Secret> {
    if (passphrase.length < 16 || passphrase.length > 1024) throw new Error("Use a unique passphrase of 16–1024 characters.");
    const rawSalt = decode(salt);
    if (rawSalt.byteLength !== 16) throw new Error("Invalid encryption salt.");
    const material = await crypto.subtle.importKey("raw", utf8.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: rawSalt, iterations: ITERATIONS }, material,
        { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { key, salt };
}

export async function seal(value: unknown, secret: Secret, context: Context): Promise<Envelope> {
    const plaintext = utf8.encode(JSON.stringify(value));
    if (plaintext.byteLength > MAX_VAULT_BYTES) throw new Error("Encrypted buffer capacity reached (8 MiB).");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(context, secret.salt), tagLength: 128 }, secret.key, plaintext);
    return { version: 1, context, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, cipher: "AES-256-GCM",
        salt: secret.salt, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

export async function open(envelope: unknown, secret: Secret, context: Context): Promise<unknown> {
    const e = parseSafe(envelopeSchema, envelope);
    if (e.context !== context || e.salt !== secret.salt) throw new Error("Wrong encrypted document type.");
    try {
        const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(e.iv), additionalData: aad(context, e.salt), tagLength: 128 }, secret.key, decode(e.ciphertext));
        if (clear.byteLength > MAX_VAULT_BYTES) throw new Error();
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
    } catch { throw new Error("Cannot decrypt: wrong passphrase or damaged file."); }
}

export async function digest(value: unknown): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", utf8.encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
