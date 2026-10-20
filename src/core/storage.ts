import type { Envelope } from "./crypto";

export interface StoredVault { revision: number; envelope: Envelope }
export interface VaultStorage {
    read(): Promise<StoredVault | undefined>;
    compareAndSet(expected: number, envelope: Envelope): Promise<number>;
}

// One encrypted document; no conversation IDs, grants, or plaintext indexes on disk.
export class IndexedDbStorage implements VaultStorage {
    constructor(private name = "vencord-message-collector-v1") {}
    private connect(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.name, 1);
            req.onupgradeneeded = () => req.result.createObjectStore("vault");
            req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
            req.onerror = () => reject(new Error("Unable to open local encrypted storage."));
            req.onblocked = () => reject(new Error("Close other collector tabs and retry."));
        });
    }
    async read(): Promise<StoredVault | undefined> {
        const db = await this.connect();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("vault", "readonly");
            const req = tx.objectStore("vault").get("current");
            tx.oncomplete = () => { db.close(); resolve(req.result as StoredVault | undefined); };
            tx.onabort = tx.onerror = () => { db.close(); reject(new Error("Unable to read local encrypted storage.")); };
        });
    }
    async compareAndSet(expected: number, envelope: Envelope): Promise<number> {
        const db = await this.connect();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("vault", "readwrite");
            const objectStore = tx.objectStore("vault");
            const req = objectStore.get("current");
            let conflict = false;
            req.onsuccess = () => {
                if ((req.result?.revision ?? 0) !== expected) { conflict = true; tx.abort(); return; }
                objectStore.put({ revision: expected + 1, envelope }, "current");
            };
            tx.oncomplete = () => { db.close(); resolve(expected + 1); };
            tx.onabort = tx.onerror = () => {
                db.close(); reject(new Error(conflict ? "Buffer changed in another tab. Lock and unlock before retrying." : "Unable to save encrypted buffer. No changes were committed."));
            };
        });
    }
}
