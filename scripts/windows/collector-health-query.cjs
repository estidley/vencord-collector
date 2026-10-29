// Read-only health probe for the personal-coordination-mcp receiver used by CollectorWatchdog.ps1.
// Reads ONLY plaintext audit timestamps (action/outcome/at). Never opens message payloads, keys or tokens.
"use strict";
const { DatabaseSync } = require("node:sqlite");
const path = process.argv[2];
try {
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare(`select
        max(case when action = 'ingest' and outcome = 'ok' then at end) as lastIngestAt,
        max(case when action = 'checkpoint' and outcome = 'ok' then at end) as lastHeartbeatAt
        from audit where seq > (select coalesce(max(seq), 0) - 50000 from audit)`).get();
    process.stdout.write(JSON.stringify({ ok: true, lastIngestAt: row.lastIngestAt ?? null, lastHeartbeatAt: row.lastHeartbeatAt ?? null }));
} catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 200) }));
}
