import test from "node:test";
import assert from "node:assert/strict";
import { derive, open, seal } from "../src/core/crypto";
import { eventSchema, provenanceSchema, MAX_INPUT_BYTES } from "../src/core/schema";
import { parseImport } from "../src/core/importer";
import { PASSWORD, provenance, withGrant, draft, NOW, input } from "./fixtures";

test("encryption uses fresh IVs, authenticated metadata and non-extractable keys", async () => {
    const secret = await derive(PASSWORD); assert.equal(secret.key.extractable, false);
    const a = await seal({ private: "text" }, secret, "collector-vault/v1");
    const b = await seal({ private: "text" }, secret, "collector-vault/v1");
    assert.notEqual(a.iv, b.iv); assert.notEqual(a.ciphertext, b.ciphertext);
    assert.deepEqual(await open(a, secret, "collector-vault/v1"), { private: "text" });
    await assert.rejects(open({ ...a, ciphertext: (a.ciphertext[0] === "A" ? "B" : "A") + a.ciphertext.slice(1) }, secret, "collector-vault/v1"), /Cannot decrypt/);
    await assert.rejects(open({ ...a, context: "coordination-batch/v1" }, secret, "coordination-batch/v1"), /Cannot decrypt/);
    await assert.rejects(open({ ...a, iterations: 1 }, secret, "collector-vault/v1"), /Invalid format/);
    await assert.rejects(derive("short"), /16/);
});

test("provenance preserves server, thread parent and DM separation", () => {
    assert.ok(provenanceSchema.safeParse(provenance).success);
    const thread = { ...provenance, kind: "guild-thread", guildId: "9", parentChannelId: "8", threadId: provenance.channelId };
    assert.ok(provenanceSchema.safeParse(thread).success);
    assert.ok(!provenanceSchema.safeParse({ ...thread, threadId: "7" }).success);
    assert.ok(!provenanceSchema.safeParse({ ...provenance, guildId: "9" }).success);
    assert.ok(!provenanceSchema.safeParse({ ...thread, guildId: null }).success);
});

test("official selected messages.json maps sender and provenance explicitly and excludes attachments", () => {
    const g = withGrant(draft({ source: "discord-data-package" }));
    const parsed = parseImport(JSON.stringify([{ ID: "12345678901234567890", Timestamp: "2026-10-18 10:00:00.123000", Contents: "own text", Attachments: "https://example.invalid/private" }]), g);
    assert.equal(parsed.messages[0]!.messageId, "12345678901234567890");
    assert.equal(parsed.messages[0]!.senderId, g.accountId);
    assert.equal(parsed.messages[0]!.createdAt, "2026-10-18T10:00:00.123Z");
    assert.ok(!JSON.stringify(parsed).includes("example.invalid"));
    assert.deepEqual(parsed.provenance, g.provenance);
});

test("malformed, oversized, numeric-ID, unknown-field and oversized-batch inputs fail closed", () => {
    const g = withGrant();
    for (const text of ["{bad", "x".repeat(MAX_INPUT_BYTES + 1), input({ messages: [] }), input({ messages: Array(1001).fill({}) })]) assert.throws(() => parseImport(text, g));
    const packageGrant = withGrant(draft({ source: "discord-data-package" }));
    assert.throws(() => parseImport(JSON.stringify([{ ID: 123, Timestamp: "yesterday", Contents: "x" }]), packageGrant));
});

test("event contract supports partial bot updates and content-free deletions, with unknown sender/time", () => {
    const base = { version: 1, eventId: crypto.randomUUID(), messageId: "3", source: "authorized-bot", accountId: "1", provenance,
        provenanceEvidence: "authorized-source", grantId: crypto.randomUUID(), observedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 1000).toISOString(), sourceTimestamp: null, senderId: null };
    assert.ok(eventSchema.safeParse({ ...base, type: "message.delete" }).success);
    assert.ok(!eventSchema.safeParse({ ...base, type: "message.delete", content: "deleted content" }).success);
    assert.ok(eventSchema.safeParse({ ...base, type: "message.update", patch: {} }).success);
    assert.ok(eventSchema.safeParse({ ...base, type: "message.update", patch: { content: "" } }).success);
    assert.ok(!eventSchema.safeParse({ ...base, type: "message.delete", source: "manual" }).success);
});
