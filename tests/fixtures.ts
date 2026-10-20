import type { Grant, Provenance } from "../src/core/schema";
import type { StoredVault, VaultStorage } from "../src/core/storage";
import type { Envelope } from "../src/core/crypto";

export const NOW = Date.parse("2026-10-19T12:00:00.000Z");
export const PASSWORD = "unique test buffer passphrase";
export const TRANSFER = "different transfer passphrase";
export const provenance: Provenance = { kind: "dm", guildId: null, guildName: null,
    channelId: "200000000000000001", channelName: null, parentChannelId: null, threadId: null,
    participantIds: ["100000000000000001"] };
export const draft = (overrides: Record<string, unknown> = {}) => ({
    source: "manual", accountId: "100000000000000001", provenance,
    allowedSenderIds: ["100000000000000001"], purpose: "Personal conversation reference",
    expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(), retentionDays: 1,
    allowExport: false, principalId: "owner", ...overrides
});
export const input = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    version: 1, accountId: "100000000000000001", provenance,
    messages: [{ messageId: "300000000000000001", senderId: "100000000000000001",
        createdAt: "2026-10-18T10:00:00Z", editedAt: null, content: "private canary message" }], ...overrides
});
export class MemoryStorage implements VaultStorage {
    value?: StoredVault;
    fail = false;
    async read() { return structuredClone(this.value); }
    async compareAndSet(expected: number, envelope: Envelope) {
        if (this.fail) throw new Error("Storage failed.");
        if ((this.value?.revision ?? 0) !== expected) throw new Error("Concurrent modification.");
        this.value = { revision: expected + 1, envelope: structuredClone(envelope) };
        return expected + 1;
    }
}
export const withGrant = (d = draft()): Grant => ({ ...d, grantId: crypto.randomUUID(), grantedAt: new Date(NOW).toISOString(), authority: "user-attested", revokedAt: null }) as Grant;
