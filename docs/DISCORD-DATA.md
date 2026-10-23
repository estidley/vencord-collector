# Vencord Collector: messages, events and activity

**2026-10-22 update:** [People-first capture and read-only MCP integration](EXPANDED-CAPTURE.md) adds personal nickname preference, scoped message details and activity sync. That guide supersedes older activity-local-only limitations below.

The product and repository are now **Vencord Collector** / `vencord-collector`. The existing plugin ID `MessageCollector`, generated folder `messageCollector`, native helper name, and IndexedDB database name intentionally stay stable. They are compatibility identifiers: existing encrypted buffers, enabled settings and remembered-password records must not be orphaned by a cosmetic rename. In Vencord's plugin list search for **MessageCollector**; its description and settings panel say **Vencord Collector**.

## Capture a section of older messages

1. Start collection using the usual password and acceptance button.
2. Open a conversation you are authorized to export in Discord. Use Discord normally to load the desired section. No automated navigation is provided.
3. Open the collector settings, expand **Save messages already loaded in Discord**, then press **Review loaded conversation**.
4. Check the channel ID, count and text sample. Confirm authority and press **Save reviewed loaded messages**.

This reads only the selected channel's current `MessageStore.getMessages(channelId)._array`, at most 1,000 messages / 2 MiB of serialized snapshot text per selection. It performs no Discord API calls, automatic scrolling, search requests, token access or channel traversal. Changing conversations invalidates the selection. It skips ephemeral/unsent messages, unsupported records and senders outside the active permission. Only text and provenance are copied; files and embeds are excluded.

Snapshots have `message.snapshot`, `source: vencord-live` and `provenanceEvidence: client-observed`. Their original creation/edit time is separate from the time of collection. They do not pretend an old message just arrived. Existing live versions and retained deletion tombstones take precedence. Dedupe and deletion protection last only while their records are retained. Unknown/deleted messages cannot be reconstructed.

Discord evicts cached messages. Previously visiting a channel does not mean its history remains loaded. The tool does not promise that scrolling and clicking repeatedly will recover a whole archive. This is a bounded, explicit export convenience, not an unattended scraping workflow. Modified-client and collection restrictions still apply; being visible does not itself establish permission to reuse data.

## Scheduled events and people

Start account-wide message collection, then expand **Scheduled events, presence and voice**. These categories are off for all existing permissions until separately accepted. Choose:

- **Scheduled server events:** enter server IDs, or use **Add current server** while a server channel is selected. Open Discord's Events view to let Discord load the schedule normally. The collector reads the chosen servers' cached schedules every five seconds, deduplicating unchanged entries.
- **Presence for selected people:** enter user IDs. Only cached, account-visible status is read. This is not specific to a server. An initial observation has no previous status; later observations describe changes. A missing cache entry is unknown, not offline. Invisible cannot be distinguished from offline. Short transitions between samples may be missed.
- **Voice channels for selected people:** enter server IDs and user IDs. The collector records known cached occupancy as a baseline, then observes delivered voice changes. A leave/move can include how long the previous channel was observed. This is a lower bound on the visit, not the true join time. It does not record audio, video, mute/deafen state, session IDs or screen contents.

Confirm permission and save the choices. With an always-on grant, they resume with that grant after reopening Discord. Changing choices erases observations outside the new scope. **Disable activity and erase observations** leaves message collection running. Stopping message collection also stops activity. Account changes lock both.

Event snapshots contain server/event/channel IDs, creator ID when known, title, description, scheduled start/end, status, location and a normalized recurrence rule. They are cached observations, not authoritative calendar confirmations. A missing event is never automatically marked deleted/cancelled. Cancellation is retained when the cache supplies that status. Recurrence exceptions and future recurrence expansion are **unresolved**; do not schedule recurring reminders from the base start alone. Open Discord to verify the current occurrence.

Reconnects, reloads, changed permissions and polling stalls over 15 seconds reset observation baselines. Queue or storage failures pause collection rather than dropping observations silently. Even within an observed interval, delivery is not guaranteed. Baseline/reconnect records must never trigger “someone logged in” alerts.

## Retention and MCP handoff

Activity is inside the same password-encrypted vault, with the permission's finite retention period (default seven days), at most 2,000 activity observations and a shared 8 MiB plaintext bound. Activity rolls out oldest observations from its own permission only; it cannot evict messages or other permissions. Message capacity remains 5,000. The activity queue is bounded to 250 observations / 512 KiB serialized text. This is a temporary buffer, not permanent history or a backup.

Explicitly enable **Allow an explicit encrypted activity handoff**, then supply a separate transfer password and confirm **Download encrypted activity**. This creates a file; nothing is uploaded. The activity protocol and decoder are in [CONNECTOR.md](CONNECTOR.md). Receiver sync covers messages only; activity observations are not synced, and notification delivery and AI actions are not implemented. A future receiver must authenticate its agent, enforce category/person/server permissions, deduplicate, check freshness, ignore baseline presence for alerts and ask before sending messages or taking external actions. Event titles/descriptions and message text are untrusted content, not agent instructions.

## Other useful data and authorized history options

| Candidate | Useful purpose | Current implementation |
|---|---|---|
| Scheduled events and changes | Planning, upcoming-session reminders | Cached snapshots implemented; recurring occurrence resolution and reliable delete history remain gaps |
| Presence and voice | A selected friend appears online; a group is in voice | Opt-in observations implemented; exact login/read activity unavailable |
| Pins, announcements and forum/thread metadata | Important decisions, ongoing topics | Thread provenance exists; dedicated pin/announcement records are future work |
| Reactions, polls and event RSVPs | Votes and participation | Future work; obtain appropriate scope rather than treating a reaction as general consent |
| Membership join dates | How long someone has belonged to a server | Future work; distinct from joining a voice session or opening Discord |
| Attachments | Shared documents | Not downloaded; would need separate opt-in, size limits and handling of untrusted files |

For a larger historical import, Discord's [official data package](https://support.discord.com/hc/en-us/articles/360004957991-Your-Discord-Data-Package) supplies your sent messages, not everybody else's messages. The existing importer accepts selected documented message files.

An authorized bot can access [server message history](https://docs.discord.com/developers/resources/message#get-channel-messages) only within its actual channel/history permissions, content intent eligibility and Discord policies. A bot can also receive [scheduled events, presence and voice updates](https://docs.discord.com/developers/events/gateway-events) with the necessary intents, including privileged presence access where applicable. It cannot read personal DMs between two other accounts. Server installation and permission are prerequisites, not blanket approval for bulk archiving or profiling. The [Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy) and [self-bot restriction](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots) still apply. No bot or crawler is deployed by this repository.

Sources and Vencord cached-store typings were inspected on 2026-10-19. Actual logged-in runtime compatibility is still unverified; see [VERIFICATION.md](VERIFICATION.md).
