# Local import formats

Only one selected conversation file is processed at a time. The app does not enumerate directories or ingest ZIP archives. File size is limited to 2 MiB and 1,000 records. Limits bound memory and make review practical; they are not a way to legitimize disallowed collection.

## Normalized manual records

Select a UTF-8 JSON object matching `examples/manual-conversation.json` and `protocol/manual.schema.json`. Every ID must be a decimal **string** (never a JSON number). Use ISO 8601 timestamps with a timezone. Missing names, guild IDs in DMs, and unavailable edit times are explicit nulls.

The entire file must match the selected permission's account and provenance. Every sender must be in that permission's allowlist. A mismatch rejects the whole import. Fields outside the schema are rejected. HTML is shown as plain text, never interpreted or fetched.

`guild-thread` uses the thread's ID for both `channelId` and `threadId`; `parentChannelId` identifies its parent, and `guildId` the server. A normal server channel has null thread/parent fields. DM and group DM provenance has no server ID. Use `unknown` when the type cannot be established, and preserve only known metadata. Participant IDs are explicitly supplied metadata, not discovered relationships.

## Official Discord package

Request and download your package through Discord. Unpack it locally. Select the transcript for the one conversation you have authorized. Set the permission's `source` to `discord-data-package`. Enter your own account ID, its sole allowed sender ID, and the known provenance from that conversation's metadata. Do not import the account file, which may contain unrelated sensitive information.

The adapter accepts the JSON transcript array shape:

```json
[
  {
    "ID": "300000000000000001",
    "Timestamp": "2026-10-18 10:00:00.000000",
    "Contents": "A message I sent",
    "Attachments": ""
  }
]
```

This shape is based on the documented message fields. It has synthetic fixture coverage, not verification against your own package. Legacy timestamps without timezone are interpreted as UTC; explicitly zoned ISO timestamps retain their instant. Fractional seconds are normalized to milliseconds. Attachment fields may be strings or arrays of strings but are discarded. No URLs are fetched.

Different export revisions, legacy CSV, numeric JSON IDs, missing fields, or extra transcript fields fail closed. Numeric snowflakes may already have lost precision in ordinary JSON parsing; do not coerce them. Convert an unsupported offline export using a lossless tool, preserving string IDs and provenance, into the documented manual format before import. No such converter is included yet.

Sender identity for this route is the user-supplied package owner's ID; provenance is likewise marked `user-supplied`. The app cannot attest to file authenticity. It cannot recover other participants' text, deleted messages, or edit history from an account's export.

## Snapshot semantics

Imported messages produce `message.snapshot`, with original creation time, supplied edit time when available, and a distinct local observation time. A snapshot is not evidence that a create/edit/delete event was observed. Exact repeats under the same permission are deduplicated. Re-importing changed text yields a separate snapshot rather than a fabricated edit event. Stable event IDs make repeated exports deduplicable by the receiver.
