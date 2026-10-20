import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { IndexedDbStorage } from "../src/core/storage";
import { derive, seal } from "../src/core/crypto";
import { PASSWORD } from "./fixtures";

test("IndexedDB commits survive reopening and concurrent CAS has exactly one winner", async () => {
    const name = crypto.randomUUID(); const a = new IndexedDbStorage(name); const b = new IndexedDbStorage(name);
    assert.equal(await a.read(), undefined);
    const e = await seal({ test: true }, await derive(PASSWORD), "collector-vault/v1");
    const results = await Promise.allSettled([a.compareAndSet(0, e), b.compareAndSet(0, e)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
    assert.equal((await new IndexedDbStorage(name).read())!.revision, 1);
    assert.equal(await b.compareAndSet(1, e), 2);
    await assert.rejects(a.compareAndSet(1, e), /another tab/);
});
