import type * as ReactTypes from "react";
import { Collector } from "../core/collector";
import { MAX_INPUT_BYTES, parseJson } from "../core/schema";

export function exampleGrant() {
    return {
        source: "manual", accountId: "100000000000000001",
        provenance: { kind: "dm", guildId: null, guildName: null,
            channelId: "200000000000000001", channelName: null, parentChannelId: null,
            threadId: null, participantIds: ["100000000000000001"] },
        allowedSenderIds: ["100000000000000001"], purpose: "Personal conversation reference",
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), retentionDays: 7,
        allowExport: false, principalId: "owner"
    };
}

// React is supplied by the host. The Vencord bundle uses Discord's React; the offline app uses its own.
export function createPanel(React: Pick<typeof ReactTypes, "createElement" | "useState" | "useRef" | "useEffect">, collector: Collector) {
    return function Panel() {
        const [status, setStatus] = React.useState(collector.status());
        const [message, setMessage] = React.useState("Locked. Create or unlock your encrypted buffer.");
        const [busy, setBusy] = React.useState(false);
        const [draft, setDraft] = React.useState(() => JSON.stringify(exampleGrant(), null, 2));
        const [attested, setAttested] = React.useState(false);
        const [grantId, setGrantId] = React.useState("");
        const [input, setInput] = React.useState("");
        const [preview, setPreview] = React.useState<ReturnType<Collector["preview"]>>();
        const [confirmed, setConfirmed] = React.useState(false);
        const [exportConfirmed, setExportConfirmed] = React.useState(false);
        const password = React.useRef<HTMLInputElement>(null);
        const transferPassword = React.useRef<HTMLInputElement>(null);
        const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
        const file = React.useRef<HTMLInputElement>(null);
        const mounted = React.useRef(true);
        const activeGrant = status.grants.find(g => g.grantId === grantId);
        function clearImport() { setInput(""); setPreview(undefined); setConfirmed(false); if (file.current) file.current.value = ""; }
        function touch() {
            clearTimeout(timer.current);
            if (collector.unlocked) timer.current = setTimeout(() => collector.lock(), 5 * 60_000);
        }
        React.useEffect(() => {
            mounted.current = true;
            const unsubscribe = collector.subscribe(() => {
                setStatus(collector.status());
                if (!collector.unlocked) {
                    clearImport(); setExportConfirmed(false); setAttested(false); setGrantId("");
                    setDraft(JSON.stringify(exampleGrant(), null, 2));
                    if (password.current) password.current.value = "";
                    if (transferPassword.current) transferPassword.current.value = "";
                    setMessage("Locked. Local data remains encrypted.");
                }
            });
            const hidden = () => { if (document.hidden) collector.lock(); };
            const lock = () => collector.lock();
            document.addEventListener("visibilitychange", hidden);
            window.addEventListener("pagehide", lock);
            return () => {
                mounted.current = false; unsubscribe(); clearTimeout(timer.current); collector.lock();
                document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", lock);
            };
        }, []);
        async function run(fn: () => Promise<string>) {
            setBusy(true);
            try { const result = await fn(); if (mounted.current) setMessage(result); }
            catch (e) { if (mounted.current) setMessage(e instanceof Error ? e.message : "Operation failed."); }
            finally { if (mounted.current) { setBusy(false); setStatus(collector.status()); touch(); } }
        }
        const field: ReactTypes.CSSProperties = { display: "block", margin: "12px 0" };
        const control: ReactTypes.CSSProperties = { width: "100%", boxSizing: "border-box", padding: 8, color: "#18212c", background: "#fff", border: "1px solid #8b97a5", borderRadius: 4 };
        return <section style={{ background: "#f5f7fa", color: "#18212c", padding: 20, borderRadius: 8, fontFamily: "system-ui", lineHeight: 1.5 }} onInput={touch} onClick={touch}>
            <h2>Conversation import</h2>
            <p>Import files you choose into an encrypted local buffer. No live Discord capture or history fetching.</p>
            <p role="status" aria-live="polite">{message}</p>
            {!collector.available && <p>Enable this plugin to use the local import panel.</p>}
            {!status.unlocked ? <form onSubmit={e => {
                e.preventDefault(); const value = password.current?.value ?? "";
                if (password.current) password.current.value = "";
                void run(async () => { await collector.unlock(value); return "Unlocked. No conversations are captured automatically."; });
            }}>
                <label style={field}>Buffer passphrase (at least 16 characters)
                    <input ref={password} type="password" minLength={16} maxLength={1024} autoComplete="off" required style={control} />
                </label>
                <button disabled={busy || !collector.available}>Create or unlock buffer</button>
                <p>Keep this passphrase safe. There is no recovery. Clearing this site's storage removes the buffer.</p>
            </form> : <>
                <p><strong>{status.count} snapshots buffered</strong> · Locks after five minutes without interaction, when hidden, or when this panel closes.</p>
                <button onClick={() => collector.lock()}>Lock now</button>{" "}
                <button disabled={busy} onClick={() => void run(async () => { await collector.prune(); return "Expired snapshots removed."; })}>Remove expired snapshots</button>
                <fieldset disabled={busy} style={{ marginTop: 20 }}>
                    <legend>1. Authorize a conversation</legend>
                    <p>Edit the example IDs and scope below. For an official messages.json file, set source to discord-data-package and use only your own sender ID. Names and missing metadata may be null; never guess IDs.</p>
                    <label style={field}>Conversation permission (JSON)
                        <textarea rows={14} value={draft} onChange={e => { setDraft(e.target.value); setAttested(false); }} style={{ ...control, fontFamily: "monospace" }} />
                    </label>
                    <label style={field}><input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} /> I have authority to store these specific messages for the stated purpose and any required participant permission. This does not grant Discord platform approval.</label>
                    <button disabled={!attested} onClick={() => void run(async () => {
                        const grant = await collector.grant(parseJson(draft), attested);
                        setGrantId(grant.grantId); setAttested(false); clearImport(); setExportConfirmed(false);
                        return "Conversation permission saved. Choose a local file to review.";
                    })}>Save permission</button>
                </fieldset>
                <fieldset disabled={busy} style={{ marginTop: 20 }}>
                    <legend>2. Review and import</legend>
                    <label style={field}>Conversation permission
                        <select value={grantId} onChange={e => { setGrantId(e.target.value); clearImport(); setExportConfirmed(false); }} style={control}>
                            <option value="">Choose a permission</option>
                            {status.grants.filter(g => !g.revokedAt && Date.parse(g.expiresAt) > Date.now()).map(g =>
                                <option key={g.grantId} value={g.grantId}>{g.provenance.kind} · {g.provenance.channelId} · {g.source} · {g.principalId}</option>)}
                        </select>
                    </label>
                    <label style={field}>Local JSON file (up to 2 MiB / 1,000 messages)
                        <input ref={file} disabled={!grantId} type="file" accept=".json,application/json" onChange={e => {
                            const chosen = e.target.files?.[0]; clearImport(); if (!chosen) return;
                            void run(async () => {
                                if (chosen.size > MAX_INPUT_BYTES) throw new Error("File exceeds the 2 MiB import limit.");
                                const text = await chosen.text(); const parsed = collector.preview(text, grantId);
                                setInput(text); setPreview(parsed); return "Review the conversation and sample below before importing.";
                            });
                        }} />
                    </label>
                    {preview && <div>
                        <p>{preview.messages.length} messages · channel {preview.provenance.channelId} · sender IDs {Array.from(new Set(preview.messages.map(m => m.senderId))).join(", ")}</p>
                        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 220, overflow: "auto" }}>{preview.messages.slice(0, 5).map(m => `${m.createdAt} — ${m.senderId}\n${m.content.slice(0, 500)}`).join("\n\n")}</pre>
                        <p>Only text is imported. Attachment links, files, embeds, and extra account data are excluded.</p>
                        <label style={field}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Import all {preview.messages.length} reviewed messages under the selected permission.</label>
                        <button disabled={!confirmed} onClick={() => void run(async () => {
                            const count = await collector.import(input, grantId, confirmed); clearImport(); return `${count} new snapshots encrypted and saved.`;
                        })}>Import reviewed messages</button>
                    </div>}
                </fieldset>
                <fieldset disabled={busy || !grantId} style={{ marginTop: 20 }}>
                    <legend>3. Export or revoke</legend>
                    <p>Recipient: personal-coordination-mcp / {activeGrant?.principalId ?? "none"}. Export is {activeGrant?.allowExport ? "permitted" : "disabled for this permission"}. This creates a file; nothing is sent automatically.</p>
                    <label style={field}>Separate transfer passphrase
                        <input ref={transferPassword} type="password" minLength={16} maxLength={1024} autoComplete="off" style={control} />
                    </label>
                    <label style={field}><input type="checkbox" checked={exportConfirmed} onChange={e => setExportConfirmed(e.target.checked)} /> Export this conversation for the named recipient and purpose.</label>
                    <button disabled={!exportConfirmed || !activeGrant?.allowExport} onClick={() => {
                        const passphrase = transferPassword.current?.value ?? "";
                        if (transferPassword.current) transferPassword.current.value = "";
                        void run(async () => {
                            const encrypted = await collector.export(grantId, passphrase, exportConfirmed);
                            if (!collector.unlocked || !mounted.current) throw new Error("Export cancelled because the panel locked.");
                            const url = URL.createObjectURL(new Blob([JSON.stringify(encrypted)], { type: "application/json" }));
                            const anchor = document.createElement("a"); anchor.href = url; anchor.download = "conversation.pcmc.json"; anchor.click();
                            setTimeout(() => URL.revokeObjectURL(url), 1000); setExportConfirmed(false);
                            return "Encrypted handoff created. Deliver it and its passphrase separately. Existing exports cannot be recalled here.";
                        });
                    }}>Download encrypted handoff</button>{" "}
                    <button onClick={() => void run(async () => {
                        const count = await collector.revoke(grantId); clearImport(); setGrantId(""); setExportConfirmed(false);
                        return `Permission revoked; ${count} local snapshots removed. Separately delete any previously exported copies at the receiver.`;
                    })}>Revoke permission and erase its local messages</button>
                </fieldset>
                <details style={{ marginTop: 20 }}><summary>Local audit ({status.audit.length} recent records)</summary>
                    <ul>{status.audit.slice(-20).reverse().map(a => <li key={a.auditId}>{a.at} · {a.action} · {a.count} messages · permission {a.grantId ?? "all"}</li>)}</ul>
                </details>
            </>}
        </section>;
    };
}
