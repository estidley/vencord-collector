# Platform findings and decision

Reviewed on **2026-10-19**. These are implementation constraints drawn from primary sources, not a legal opinion or a promise of approval.

## Decision

Two explicitly separated routes are implemented: a local-file importer and an unofficial passive Vencord live observer, added following the owner's explicit request. Live mode includes per-conversation start controls and an additional at-your-own-risk account-wide option. Neither mode is represented as Discord-approved. User-reviewed snapshots of the currently selected channel cache are now supported. Scheduled-event cache snapshots and individually scoped presence/voice observations are separately opt-in. No automatic history/store traversal, credential access, user-token session, collector-initiated Discord requests, automatic sending, or backfill is implemented. The risk checkbox acknowledges scope; it does not grant third-party consent or platform approval.

Technical access is broader than an official bot's access: Vencord runs inside the signed-in client and can receive DM events already delivered there. Passive observation does not require extracting the user token or creating a separate automated account connection. That technical distinction does not make the modified client compliant with Discord's Terms. See the [Vencord FAQ](https://vencord.dev/support/) and [inspected upstream implementation](VENCORD.md).

## Primary sources

- [Discord Terms of Service](https://discord.com/terms), effective September 29, 2025, sections 6 and 9: client modification and unauthorized scraping are restricted. User access to a channel is not a blanket grant to automate collection.
- [Automated User Accounts (Self-Bots)](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots): automation of normal user accounts outside the bot/OAuth2 API is forbidden.
- [Discord Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy), effective July 8, 2024: requires permission, respect for opt-outs, purpose limitation and careful data handling; prohibits scraping, user/relationship profiling, and unauthorized training on API message content. A bot token alone does not authorize general-purpose archiving or downstream profiling.
- [Requesting your data](https://support.discord.com/hc/en-us/articles/360004027692-Requesting-a-Copy-of-your-Data) and [Data Package contents](https://support.discord.com/hc/en-us/articles/360004957991-Your-Discord-Data-Package): an official download contains messages the requesting account sent, separated by conversation with context metadata. It is not the other side of every conversation or a record of deleted messages.
- [Gateway intents](https://docs.discord.com/developers/events/gateway): message content availability depends on intents and applicable approval. Check current review requirements when implementing the bot; do not hard-code old thresholds.
- [Gateway message events](https://docs.discord.com/developers/events/gateway-events#message-create): official create/update/delete events are available to eligible applications. A delete contains message/channel IDs and optional guild ID; it does not supply deleted text or the original sender.

## Authorized alternatives, with remaining conditions

**Official data export — implemented locally.** Request a package in Discord's own UI, unpack it yourself, then select one conversation's message file. Enter its metadata and your account ID. This importer never requests or downloads the package. Unknown export shapes are rejected, not guessed. No account.json or whole ZIP ingestion is provided.

**Manual selected records — implemented locally.** Prepare the small normalized JSON format from records you are entitled to use. The importer records a user attestation; it cannot verify the true origin or third-party consent. Do not use a scraper as an upstream producer.

**Official app/bot — design only.** Prefer an explicit message command/interaction that lets a user submit a selected message to the declared workflow. If ongoing events are necessary, define the purpose narrowly, obtain installation and channel permissions and required consent, check applicable intent review, and enforce opt-out/removal/retention rules. Request Discord's written guidance before expanding this into broad archival collection. Neither server-owner approval nor privileged intent access waives the Developer Policy.

A bot does not provide access to arbitrary conversations between the user's personal account and other people. Bot-visible DMs are those involving the bot; private threads also depend on actual access. Do not promise completeness, automatic historical backfill, or deleted-message recovery. Never infer a deletion from absence in an export.

## Explicit gaps

- No automated historical extraction, token access, collector-initiated Discord HTTP requests or separate Gateway connection. Explicit cached selections can contain older messages, but do not establish a complete archive. Live capture observes only events already delivered by the client; completeness is not guaranteed.
- No general sanctioned Vencord plugin route established by this research.
- No bot deployment, intent approval, participant-consent service, or live permission synchronizer.
- Opt-in receiver sync delivers only to `personal-coordination-mcp` on `127.0.0.1`; no other upload target. No authenticated downstream revocation from the collector.
- No AI training, relationship profiling, attachment fetching, or hidden data collection.
