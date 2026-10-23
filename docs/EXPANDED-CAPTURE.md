# People first, expanded capture, and a read-only MCP

The People and names tab prioritizes your personal nickname from Discord's RelationshipStore. It retains this separately from a server nickname, display name, and username. Select people from IDs already in your retained messages or enter IDs. Choose servers for their cached roles and server nicknames; global names do not require a server selection. No member directory is fetched.

Choose the first name source in the tab. The remaining sources form a fallback order. The default is personal nickname, server nickname, display name, username. Activity handoffs contain the available variants; the MCP's reader policy controls which variants may reach an AI. Its default is one resolved `preferredName` and its source, not all aliases. This does not redact names someone typed into message text or historical channel labels.

## Data available

All additions are off for existing grants until selected. Activity sync also requires Allow activity sync and encrypted handoff, the existing receiver-sync setup, and a receiver policy allowing those categories and IDs.

| Choice | Captured subset |
| --- | --- |
| Selected people | Personal nickname, username, display name; per-server nickname and role IDs/names when cached |
| Replies | Referenced message/channel/server IDs; no hidden referenced-message body |
| Mentions | User IDs, role IDs, everyone flag |
| Attachments | ID, filename, size, content type, HTTP(S) URL; never file bytes |
| Links and embeds | Text URLs, preview title/description/fields; no image load, HTML rendering, or URL fetch |
| Reactions | Cached emoji/count and your reaction flag; delivered reaction events refresh known messages. No reactor enumeration |
| Polls | Cached question, answers, available counts and your vote flags, expiry/finalized state. Unknown counts remain null |
| Pinned messages | Pin state of collected, cached messages; not a crawl of the pin archive |
| Scheduled events | Changed cached snapshots and explicit delivered create/update/delete observations. Disappearance from cache is not cancellation |
| Channel/thread context | Selected channel IDs: names, topics, parent, type, archive/lock state, applied tag IDs |
| Your unread state | Selected channel unread flag, mention count, acknowledgment ID and last-message ID. No proof of human reading |
| Visible activity | Selected people's visible activities from `getActivities`, never hidden/unfiltered presence APIs |

Reactions, polls, and pins are state snapshots, not complete event histories. A five-second pass refreshes up to 100 cached messages in the currently selected channel, and only updates messages already collected. Reaction dispatches can refresh other cached known messages. No automatic historical import, scrolling, member fetching, attachment downloading, or independent Discord connection occurs.

Activity snapshots retain changes within the bounded encrypted buffer (2,000 observations, shared 8 MiB, grant retention). Sync receipts cover message and activity batches separately. Delivered observations roll out first; dropped unsent activity is audited. Outages, sleep, Discord cache behavior, and client changes can cause gaps. No login-time or attendance guarantee is made.

## Enable and connect

1. Install the rebuilt custom plugin and fully restart Discord, including its tray process, for the native helper change.
2. Keep the existing password/acceptance setup. In People and names, select people, enable identity collection, choose servers for roles, and save the choices with the authority checkbox.
3. In Messages and activity, select message detail categories and channel IDs for context/unread observations. Choose event/activity types and save.
4. Enable activity export if wanted. Configure matching importer and reader policies on personal-coordination-mcp using its `examples/*-extras-policy.json` templates. The IDs there are synthetic and must be replaced.
5. Sync now. MCP tools `get_people`, `list_activity`, and `get_channel_context` appear only for a reader credential with activity permission. Existing message tools return metadata only for permitted categories.

Disabling choices removes no-longer-permitted local activity and strips local message details. It does not retract copies already delivered to the receiver. Narrow its reader policy for immediate access restriction, or revoke the grant on the receiver to purge associated records. Scope reduction is not a distributed deletion protocol.

## Execution boundary

Collected strings are never executable code, tool names, destinations, permissions, or consent. The collector stores inert data; its native network path accepts only bounded handoffs to the configured loopback receiver. The MCP exposes read tools only. Its bridge refuses importer/admin credentials, even if those credentials also have read permission.

An AI host with unrelated shell, browser, email, or messaging tools is outside this boundary. For isolated reading, use a host/session with only this read-only MCP, no action tools, no external browsing, and no automatic attachment processing. Summaries remain untrusted; they must not be promoted into instructions for another agent. No actor, automatic notifications, or action approval service is implemented by this release.

See the receiver's `docs/RED-TEAM.md` for tests, limitations, and the deployment checklist. Tests exercise deterministic permission and data boundaries; they do not prove a model immune to prompt injection or validate every current Discord payload in a logged-in session.
