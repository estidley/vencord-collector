import type * as ReactTypes from "react";
import { Collector } from "../core/collector";
import type { LiveCapture } from "../core/live";
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
export function createPanel(React: Pick<typeof ReactTypes, "createElement" | "useState" | "useRef" | "useEffect">, collector: Collector, live?: LiveCapture) {
    return function Panel() {
        const [status, setStatus] = React.useState(collector.status());
        const [liveStatus, setLiveStatus] = React.useState(live?.status());
        const [liveConfirmed, setLiveConfirmed] = React.useState(false);
        const [showAll, setShowAll] = React.useState(false);
        const [allRiskConfirmed, setAllRiskConfirmed] = React.useState(false);
        const [allAuthority, setAllAuthority] = React.useState(false);
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
            if (collector.unlocked && !live?.active) timer.current = setTimeout(() => { if (!live?.active) collector.lock(); }, 5 * 60_000);
        }
        React.useEffect(() => {
            mounted.current = true;
            const unsubscribe = collector.subscribe(() => {
                setStatus(collector.status());
                if (!collector.unlocked) {
                    clearImport(); setExportConfirmed(false); setLiveConfirmed(false); setAttested(false); setGrantId("");
                    setShowAll(false); setAllRiskConfirmed(false); setAllAuthority(false);
                    setDraft(JSON.stringify(exampleGrant(), null, 2));
                    if (password.current) password.current.value = "";
                    if (transferPassword.current) transferPassword.current.value = "";
                    setMessage("Locked. Local data remains encrypted.");
                }
            });
            const unsubscribeLive = live?.subscribe(() => setLiveStatus(live.status()));
            const hidden = () => { if (document.hidden && !live?.active) collector.lock(); };
            const lock = () => collector.lock();
            document.addEventListener("visibilitychange", hidden);
            window.addEventListener("pagehide", lock);
            return () => {
                mounted.current = false; unsubscribe(); unsubscribeLive?.(); clearTimeout(timer.current); if (!live?.active) collector.lock();
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
            <h2>Conversation collector</h2>
            <p>{live ? "Choose file imports or explicitly start live capture for selected conversations. No history fetching." : "Import files you choose into an encrypted local buffer. For live capture, install the Vencord plugin and open its settings inside Discord. This browser app cannot see Discord messages."}</p>
            {live && <p>Vencord is an unofficial client modification and violates Discord's Terms of Service. Participant permission does not provide platform approval.</p>}
            {liveStatus && <p aria-live="polite">{liveStatus.active ? `Live: ${liveStatus.allConversations ? "ALL conversations on this account" : `${liveStatus.grantIds.length} conversation(s)`}, ${liveStatus.saved} changes saved. Ends ${new Date(liveStatus.endsAt!).toLocaleTimeString()}.` : liveStatus.notice}</p>}
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
                <p><strong>{status.count} records buffered</strong> · {liveStatus?.active ? "Live capture keeps the buffer unlocked while this panel is closed or hidden, until the session ends." : "Locks after five minutes without interaction, when hidden, or when this panel closes."}</p>
                <button onClick={() => collector.lock()}>Lock now</button>{" "}
                <button disabled={busy} onClick={() => void run(async () => { await collector.prune(); return "Expired snapshots removed."; })}>Remove expired snapshots</button>
                {live && <fieldset disabled={busy} style={{ marginTop: 20, border: "2px solid #a35313" }}>
                    <legend>Account-wide live capture</legend>
                    <button disabled={liveStatus?.active} onClick={() => { setShowAll(!showAll); setAllRiskConfirmed(false); setAllAuthority(false); }}>Allow all conversations — at my own risk</button>
                    {showAll && <div>
                        <p>This includes every supported DM, group DM, server channel and thread delivered to the signed-in account, including newly joined conversations and all senders. It does not fetch history or bypass access controls. Vencord violates Discord's Terms of Service and may put your account at risk.</p>
                        <p>The buffer remains unlocked for up to one hour, including when this panel is closed or hidden. Local retention defaults to seven days; export stays off. Capture stops if storage or the pending queue fills. Use selected conversations if you cannot authorize this whole scope.</p>
                        <label style={field}><input type="checkbox" checked={allAuthority} onChange={e => setAllAuthority(e.target.checked)} /> I have authority and any required participant permission to store messages across all these conversations.</label>
                        <label style={field}><input type="checkbox" checked={allRiskConfirmed} onChange={e => setAllRiskConfirmed(e.target.checked)} /> I accept the account and privacy risks of all-conversations capture and the one-hour unlocked session.</label>
                        <button disabled={!allAuthority || !allRiskConfirmed || liveStatus?.active} onClick={() => void run(async () => {
                            const grant = await collector.grant(live.allDraft(), allAuthority);
                            await live.start(grant.grantId, allRiskConfirmed, allRiskConfirmed);
                            setGrantId(grant.grantId); clearImport(); setExportConfirmed(false); setLiveConfirmed(false);
                            setShowAll(false); setAllRiskConfirmed(false); setAllAuthority(false);
                            return "All-conversations live capture started for this account. Stop live capture or Lock now ends the session.";
                        })}>Start all conversations for one hour</button>
                    </div>}
                </fieldset>}
                <fieldset disabled={busy} style={{ marginTop: 20 }}>
                    <legend>1. Authorize a conversation</legend>
                    <p>Edit the example IDs and scope below. For an official messages.json file, set source to discord-data-package and use only your own sender ID. Names and missing metadata may be null; never guess IDs.</p>
                    {live && <button onClick={() => void run(async () => { setDraft(JSON.stringify(live.currentDraft(), null, 2)); setAttested(false); return "Review the current conversation and sender list, then save its permission."; })}>Use current Discord conversation</button>}
                    <label style={field}>Conversation permission (JSON)
                        <textarea rows={14} value={draft} onChange={e => { setDraft(e.target.value); setAttested(false); }} style={{ ...control, fontFamily: "monospace" }} />
                    </label>
                    <label style={field}><input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} /> I have authority to store these specific messages for the stated purpose and any required participant permission. This does not grant Discord platform approval.</label>
                    <button disabled={!attested} onClick={() => void run(async () => {
                        const grant = await collector.grant(parseJson(draft), attested);
                        setGrantId(grant.grantId); setAttested(false); clearImport(); setExportConfirmed(false); setLiveConfirmed(false);
                        return grant.source === "vencord-live" ? "Permission saved. Live capture stays off until you press Start live capture." : "Conversation permission saved. Choose a local file to review.";
                    })}>Save permission</button>
                </fieldset>
                <fieldset disabled={busy} style={{ marginTop: 20 }}>
                    <legend>2. Choose a permission and capture method</legend>
                    <label style={field}>Conversation permission
                        <select value={grantId} onChange={e => { setGrantId(e.target.value); clearImport(); setExportConfirmed(false); setLiveConfirmed(false); }} style={control}>
                            <option value="">Choose a permission</option>
                            {status.grants.filter(g => !g.revokedAt && Date.parse(g.expiresAt) > Date.now()).map(g =>
                                <option key={g.grantId} value={g.grantId}>{g.scope === "account" ? "ALL conversations" : `${g.provenance?.kind} · ${g.provenance?.channelId}`} · {g.source} · {g.principalId}</option>)}
                        </select>
                    </label>
                    {live && activeGrant?.source === "vencord-live" && <div>
                        <p>Only new events delivered to this Discord client are observed. Offline gaps are not filled. Edits replace buffered live text; observed deletes remove buffered copies. Text only; attachments are excluded.</p>
                        <label style={field}><input type="checkbox" checked={liveConfirmed} onChange={e => setLiveConfirmed(e.target.checked)} /> Keep the buffer unlocked for a live session of up to one hour, even with this panel closed or hidden.</label>
                        {activeGrant.scope === "account" && <label style={field}><input type="checkbox" checked={allRiskConfirmed} onChange={e => setAllRiskConfirmed(e.target.checked)} /> I accept the account and privacy risks of capturing all conversations, including newly joined channels and all senders.</label>}
                        <button disabled={!liveConfirmed || (activeGrant.scope === "account" && !allRiskConfirmed) || liveStatus?.grantIds.includes(grantId)} onClick={() => void run(async () => { await live.start(grantId, liveConfirmed, allRiskConfirmed); setLiveConfirmed(false); setAllRiskConfirmed(false); return "Live capture started for the selected permission."; })}>Start live capture</button>
                    </div>}
                    {liveStatus?.active && <button onClick={() => live?.stop()}>Stop live capture and lock</button>}
                    <label style={field}>Local JSON file (up to 2 MiB / 1,000 messages)
                        <input ref={file} disabled={!grantId || activeGrant?.source === "vencord-live"} type="file" accept=".json,application/json" onChange={e => {
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
