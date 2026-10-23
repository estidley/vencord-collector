import { detailKeys } from "../core/details";
import type * as ReactTypes from "react";
import type { Collector } from "../core/collector";
import type { LiveCapture } from "../core/live";
import { noActivity } from "../core/activity-schema";

export function createCaptureExtras(React: Pick<typeof ReactTypes, "createElement" | "useState" | "useRef" | "useEffect">, collector: Collector, live: LiveCapture) {
    return function CaptureExtras({ status }: { status: ReturnType<Collector["status"]> }) {
        const grant = status.grants.find(g => live.status().grantIds.includes(g.grantId) && g.scope === "account");
        const [tab, setTab] = React.useState<"people" | "data">("people");
        const [permission, setPermission] = React.useState(grant?.activity ?? noActivity());
        const [details, setDetails] = React.useState(grant?.details ?? []);
        const [channels, setChannels] = React.useState(grant?.activity.channelIds.join(", ") ?? "");
        const [guilds, setGuilds] = React.useState(grant?.activity.guildIds.join(", ") ?? "");
        const [users, setUsers] = React.useState(grant?.activity.userIds.join(", ") ?? "");
        const [authority, setAuthority] = React.useState(false);
        const [preview, setPreview] = React.useState<ReturnType<LiveCapture["loadedPreview"]>>();
        const [confirmed, setConfirmed] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState("");
        const [exportConfirmed, setExportConfirmed] = React.useState(false);
        const transfer = React.useRef<HTMLInputElement>(null);
        React.useEffect(() => {
            setDetails(grant?.details ?? []); setChannels(grant?.activity.channelIds.join(", ") ?? ""); setPermission(grant?.activity ?? noActivity()); setGuilds(grant?.activity.guildIds.join(", ") ?? "");
            setUsers(grant?.activity.userIds.join(", ") ?? ""); setAuthority(false); setPreview(undefined); setConfirmed(false);
        }, [grant?.grantId]);
        async function run(fn: () => Promise<string>) {
            setBusy(true); try { setNotice(await fn()); } catch (e) { setNotice(e instanceof Error ? e.message : "Operation failed."); } finally { setBusy(false); }
        }
        const ids = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))];
        return <div>
            <p>{status.activityCount} activity observations buffered. Messages and activity are encrypted locally. Optional sync sends permitted data to your read-only MCP. No actions or downloads run from collected content.</p>
            <p role="status">{notice}</p>
            <details><summary>Save messages already loaded in Discord</summary>
                <p>Open an authorized conversation and load the section you need using Discord. Then review its cached text here. This saves at most 1,000 messages / 2 MiB per selection. The cache may contain fewer messages than you previously viewed. No automatic scrolling, history requests, or complete-archive guarantee.</p>
                <button disabled={busy || !live.active} onClick={() => void run(async () => {
                    setPreview(live.loadedPreview()); setConfirmed(false); return "Review this cached selection before saving.";
                })}>Review loaded conversation</button>
                {preview && <div>
                    <p>{preview.events.length} loaded messages · {preview.provenance.channelName ?? preview.provenance.channelId} · channel {preview.provenance.channelId}</p>
                    <pre style={{ whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto" }}>{preview.events.slice(0, 5).map(e => e.type === "snapshot" ? `${e.createdAt} · ${e.senderId}\n${e.content.slice(0, 300)}` : "").join("\n\n")}</pre>
                    <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I am authorized to save this loaded selection.</label>
                    <button disabled={busy || !confirmed} onClick={() => void run(async () => {
                        const count = await live.captureLoaded(preview, confirmed); setPreview(undefined); setConfirmed(false);
                        return `${count} snapshots processed; existing messages and retained deletions were skipped.`;
                    })}>Save reviewed loaded messages</button>
                </div>}
            </details>
            <div role="tablist" aria-label="Collection settings">
                <button role="tab" aria-selected={tab === "people"} onClick={() => setTab("people")}>People and names</button>
                <button role="tab" aria-selected={tab === "data"} onClick={() => setTab("data")}>Messages and activity</button>
            </div>
            <details open><summary>{tab === "people" ? "Personal nicknames, other names and server roles" : "Message details, events and channel context"}</summary>
                <p>Enable these separately for selected servers and people. Presence is observed online status, not a login or proof that someone is reading a server. Voice duration covers only the interval observed in a channel. Restarts and connection gaps reset that interval. No audio is recorded.</p>
                {!grant && <p>Start account-wide collection to enable these options.</p>}
                <fieldset disabled={busy || !grant}>
                    <legend>Activity permission</legend>
                    {tab === "people" && <div>
                        <p>Your personal nickname is preferred first. Available name variants are stored separately. The MCP returns only a resolved name unless its owner policy permits other variants. Roles are context, never permission to act.</p>
                        <label>Preferred name first <select value={permission.namePreference[0]} onChange={e => {
                            const key = e.target.value as typeof permission.namePreference[number];
                            setPermission({ ...permission, namePreference: [key, ...permission.namePreference.filter(k => k !== key)] }); setAuthority(false);
                        }}>{([ ["personalNickname", "My personal nickname"], ["nickname", "Server nickname"], ["displayName", "Discord display name"], ["username", "Username"] ] as const).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
                        <p>Fallback order: {permission.namePreference.join(" / ")}</p>
                        <p>Select people already present in your retained messages, or enter IDs below:</p>
                        <div style={{ maxHeight: 200, overflow: "auto" }}>{collector.people().map(person => <label key={person.id} style={{ display: "block" }}><input type="checkbox" checked={ids(users).includes(person.id)} onChange={e => {
                            setUsers((e.target.checked ? [...ids(users), person.id] : ids(users).filter(id => id !== person.id)).join(", ")); setAuthority(false);
                        }} /> {person.name} ({person.id})</label>)}</div>
                    </div>}
                    {([ ["members", "Collect selected people's personal nicknames, other names and server roles"], ["channelContext", "Channel and thread context"], ["unread", "My unread state for selected channels"], ["games", "Visible game/activity status"], ["scheduledEvents", "Scheduled server events"], ["presence", "Presence for selected people"], ["voice", "Voice channels for selected people"] ] as const).filter(([key]) => tab === "people" ? key === "members" : key !== "members").map(([key, label]) => <label key={key} style={{ display: "block" }}><input type="checkbox" checked={permission[key]} onChange={e => { setPermission({ ...permission, [key]: e.target.checked }); setAuthority(false); }} /> {label}</label>)}
                    <div hidden={tab !== "data"}>
                    <p>Message details for conversations covered by your active message permission:</p>
                    {detailKeys.map(key => <label key={key} style={{ display: "block" }}><input type="checkbox" checked={details.includes(key)} onChange={e => { setDetails(e.target.checked ? [...details, key] : details.filter(k => k !== key)); setAuthority(false); }} /> {key}</label>)}
                    <label style={{ display: "block" }}>Channel IDs for context and unread state<input value={channels} onChange={e => { setChannels(e.target.value); setAuthority(false); }} /></label>
                    <button onClick={() => void run(async () => { setChannels([...new Set([...ids(channels), live.currentDraft().provenance.channelId])].join(", ")); setAuthority(false); return "Current channel added."; })}>Add current channel</button>
                    </div><label style={{ display: "block" }}>Server IDs (comma separated)<input value={guilds} onChange={e => { setGuilds(e.target.value); setAuthority(false); }} /></label>
                    <button onClick={() => void run(async () => {
                        const id = live.currentDraft().provenance.guildId;
                        if (!id) throw new Error("Open a server channel first.");
                        setGuilds([...new Set([...ids(guilds), id])].join(", ")); setAuthority(false); return "Current server added.";
                    })}>Add current server</button>
                    <label style={{ display: "block" }}>User IDs to watch (comma separated)<input value={users} onChange={e => { setUsers(e.target.value); setAuthority(false); }} /></label>
                    <p>Copy IDs through Discord's Developer Mode. Scheduled events use server IDs only; presence is account-visible status and is not scoped to a particular server. Open the server's Events view to load its current schedule. Unloaded or removed events are not inferred as cancelled.</p>
                    <label style={{ display: "block" }}><input type="checkbox" checked={permission.allowExport} onChange={e => { setPermission({ ...permission, allowExport: e.target.checked }); setAuthority(false); }} /> Allow activity sync and encrypted handoff to personal-coordination-mcp / {grant?.principalId ?? "owner"}</label>
                    <label style={{ display: "block" }}><input type="checkbox" checked={authority} onChange={e => setAuthority(e.target.checked)} /> I confirm authority and any required permission for these selected events and people's activity.</label>
                    <button disabled={!authority} onClick={() => void run(async () => {
                        await collector.configureActivity(grant!.grantId, { ...permission, guildIds: ids(guilds), userIds: ids(users), channelIds: ids(channels) }, authority);
                        await collector.configureDetails(grant!.grantId, details, authority);
                        setAuthority(false); return "Activity permission saved. Observations resume with this collection permission; removed scopes are erased locally.";
                    })}>Save activity choices</button>
                    <button onClick={() => void run(async () => {
                        await collector.configureActivity(grant!.grantId, noActivity(), true); setPermission(noActivity()); setChannels(""); setGuilds(""); setUsers(""); setAuthority(false);
                        return "Activity collection disabled and its local observations erased.";
                    })}>Disable activity and erase observations</button>
                </fieldset>
                <p>Activity uses a rolling limit of 2,000 observations within the shared 8 MiB encrypted vault and the permission's retention period. Recurrence exceptions and future occurrences need verification before reminders are scheduled.</p>
                {grant?.activity.allowExport && <fieldset disabled={busy}>
                    <legend>Export activity</legend>
                    <label>Activity transfer passphrase<input ref={transfer} type="password" minLength={16} maxLength={1024} autoComplete="off" /></label>
                    <label><input type="checkbox" checked={exportConfirmed} onChange={e => setExportConfirmed(e.target.checked)} /> Create an activity handoff for {grant.principalId}.</label>
                    <button disabled={!exportConfirmed} onClick={() => {
                        const password = transfer.current?.value ?? ""; if (transfer.current) transfer.current.value = "";
                        void run(async () => {
                            const encrypted = await collector.exportActivity(grant.grantId, password, exportConfirmed);
                            if (!collector.unlocked) throw new Error("Export cancelled: buffer locked.");
                            const url = URL.createObjectURL(new Blob([JSON.stringify(encrypted)], { type: "application/json" }));
                            const a = document.createElement("a"); a.href = url; a.download = "activity.pcmc.json"; a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 1000); setExportConfirmed(false); return "Encrypted activity handoff created. Nothing was uploaded.";
                        });
                    }}>Download encrypted activity</button>
                </fieldset>}
            </details>
        </div>;
    };
}
