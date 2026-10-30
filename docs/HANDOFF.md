# HANDOFF: Vencord Collector always-on stall fix (Oct 29, 2026)

On Oct 29, 2026, Ethan reported that the read-only "Discord messages" MCP had stopped picking up new messages. He asked to find out why and fix it, update Discord, rebuild and re-patch Vencord (always the newest upstream), and get messages flowing again. He also said that if the repo needed changes, we should just make them. The setup runs on AETERNUM. Discord Desktop loads a custom Vencord build: the upstream checkout is in `C:\Users\Estid\Documents\Codex\2026-10-19\referenced-chatgpt-conversation-this-is-an\work\Vencord-reference`, and the MessageCollector userplugin comes from this repo. The "Repair Vencord" scheduled task (`C:\automation\Vencord\RepairVencord.ps1`, log `C:\automation\Vencord\repair.log`) keeps that build current. The plugin's always-on capture pushes records through its native helper to personal-coordination-mcp on `127.0.0.1:4320`. That receiver is restarted at startup and midnight by the "Discord Messages MCP - Startup and Midnight" task. Credentials live only in `C:\Users\Estid\AppData\Local\PersonalCoordination\<app>.secret` and in the OS-protected plugin storage, so refer to them by path only.

**Root cause:** in the receiver's audit table, the last successful ingest was Oct 25, 2026 at 2:27 PM CDT. The Discord session that was running had started on Oct 24 and stayed up the whole time. The receiver and the grants were healthy. Live capture is fail-closed: an unexpected client event, a save error, or a full queue stops capture and locks the buffer. `AlwaysOn.restore()` only ever ran once per account per Discord launch (`attempted === account`), so after a stop like that, collection and sync stayed off until Discord was fully restarted. Because the restart tasks cover only the receiver, not Discord, ingestion silently stopped.

**Fix:** when an always-on session that was running stops underneath itself, `AlwaysOn.restore()` now resumes it in the same session with backoff: 1 min, doubling, capped at 15 min, and reset after an hour of healthy capture. A resume re-runs exactly the checks a restart does: the same account, the saved grant, a continuous grant, and not revoked. Disable, an account change, shutdown, and a failed restore never auto-resume. The stop reason (never message content) is logged to the Discord console as `[MessageCollector] capture stopped...` and shown in the panel notice. Security design is unchanged otherwise. Message text is still data only, the MCP stays read-only, and no plaintext credentials are added. One behavior change to flag: before, a fail-closed stop stayed stopped until the next Discord restart. Now it auto-resumes within the session after backoff.

## Checklist
- [x] Diagnose (receiver healthy on 4320; Vencord at latest upstream 443688b / 1.15.13; last ingest Oct 25, 2026 2:27 PM CDT)
- [x] Auto-resume fix + tests (`tests/always-on.test.ts`), `npm run check` passes (78 tests)
- [x] PR #3 merged into `expanded-capture-readonly` (the deployed branch); CI green
- [x] Discord on latest stable host 1.0.9266 (was running stale 1.0.9265 session since Oct 24); Vencord 443688b (1.15.13, latest upstream) rebuilt with the fixed plugin via RepairVencord.ps1; Discord restarted on the custom build
- [x] New messages verified: ingest resumed Oct 29, 2026 12:36 PM CDT; latest ingest after rebuild 12:40 PM CDT (receiver audit table)
- [ ] Left for Ethan: `master` still lags the deployed branch (PRs #1 and #2 are open and stacked under `expanded-capture-readonly`); decide whether to merge that stack into `master`.

_Last updated: 2026-10-29 12:45 PM CDT_

---

# HANDOFF (round 2, Oct 29, 2026): backfill decision, heartbeat and watchdog

Ethan followed up: "I don't want to miss any messages that's important to me." That set two goals. (1) Backfill the outage gap from Oct 25, 2026 2:27 PM CDT to Oct 29, 2026 12:36 PM CDT, prioritizing DMs, group DMs and @mentions, but only if it can be done safely: paced, deduplicated, and no self-bot patterns beyond normal client behavior. (2) Make sure an outage can never go silent again: add a watchdog on AETERNUM that detects "capture is off" and runs safe recovery, plus a health status that can be read remotely so a routine can alert Ethan. The same rules apply: no deletes, no OneDrive, no secrets printed, the MCP stays read-only and message text never triggers commands, and repo changes go through a branch and PR off `expanded-capture-readonly`.

**(1) Backfill: not done automatically, by design.** This repo deliberately forbids automated history fetching. `CONNECTOR.md` says gateway gaps "do not justify scraping/backfill". The loaded-message feature makes "no Discord API calls, automatic scrolling, search requests, token access or channel traversal" (`DISCORD-DATA.md`). `DISCORD-DATA.md` also cites Discord's self-bot restriction: "No bot or crawler is deployed by this repository." A plugin that walks DMs or mentions through Discord's REST API on Ethan's account is an automated user account (a self-bot). That risks his account and would override a security boundary, so it was not built. The supported recovery is the existing manual **loaded-message snapshot**: open a DM in Discord, and the client loads its recent history the normal way; then use the plugin's capture-loaded action. It dedupes by message ID and stays within the 7-day buffer. See the steps below.

**(2) Heartbeat + watchdog.** Silence alone can't tell "quiet" from "broken". Healthy ingest gaps reached 2 to 10 hours in quiet stretches, while the 99th percentile is about 4.5 min. So `SyncController` now sends a content-free heartbeat every 5 min while capture is running, even when idle. It reuses the existing authenticated `/v1/checkpoint` call, which the receiver audits as `checkpoint ok`. The heartbeat stops the instant capture stops. There is no new endpoint, no new secret, and no message data. `scripts/windows/CollectorWatchdog.ps1` reads only the receiver's plaintext audit timestamps (read-only), using `collector-health-query.cjs`, and writes a health JSON file.

## Watchdog
- Task **"Discord Collector Watchdog"**, every 15 min plus at logon, runs as Ethan's interactive user via `conhost --headless` (no console flash). Deployed copy: `C:\automation\Vencord\CollectorWatchdog.ps1` (+ `collector-health-query.cjs`).
- **Unhealthy** = Discord is running, the receiver is up, and there has been no ingest and no heartbeat for **> 20 min**. That is 4x the heartbeat, and longer than the plugin's own 15-min max self-resume, so the plugin gets to heal itself first.
- **Recovery** = stop Discord, then run `RepairVencord.ps1`. That re-patches the newest Discord onto the custom build if an update wiped it, then launches Discord. If Discord isn't running at all, it is relaunched the same way.
- **Safety limits:** a relaunch is confirmed by polling for the Discord process (with an `Update.exe` fallback). Only a confirmed relaunch starts the cooldown (60 min in round 2; 5 min after round 3, see below). If Discord can't be brought back, the state is `recovery-failed` and the next run retries; this was a Bugbot finding on PR #5. Otherwise at most one recovery per 60 min. After 3 consecutive recoveries that don't restore health, auto-restart stops and the state becomes `needs-attention`. If the receiver is down (`receiver-down`), Discord is left alone, because the receiver has its own supervisor. Pass `-NoRestart` to only report.
- **Flag:** a recovery restarts Discord, which drops an active voice call. It only fires after 20+ min of confirmed dead capture.

## Reading health remotely
File: `C:\Users\Estid\AppData\Local\PersonalCoordination\collector-health.json`. It contains no secrets or content, and times carry their UTC offset.
```
Get-Content "$env:LOCALAPPDATA\PersonalCoordination\collector-health.json" | ConvertFrom-Json
```
- `state`: `ok` | `stale` | `recovering` | `recovery-failed` | `discord-not-running` | `receiver-down` | `needs-attention` | `unknown`. Alert on anything other than `ok` (and `recovering` that persists).
- `checkedAt`: if it's older than about 35 min, the watchdog itself isn't running (machine asleep/off/logged out). Treat that as unknown and alert.
- Log: `C:\Users\Estid\AppData\Local\PersonalCoordination\logs\collector-watchdog.log`.

## Manual recovery of gap messages (safe)
In Discord: open each important DM or group DM from Oct 25 to 29 (and Inbox → Mentions, clicking through to each ping). Then, in Vencord settings → MessageCollector → capture loaded messages, review and confirm. The client loads the history the normal way, and snapshots dedupe by message ID.

## Checklist (round 2)
- [x] Backfill assessed; automated backfill not built (self-bot / design boundary). Manual safe path documented.
- [x] Capture heartbeat (`src/core/sync.ts`) + test; `npm run check` passes 79/79
- [x] Watchdog + read-only health query written; dry-run verified (`ok`, and forced `stale` with `-NoRestart`)
- [x] PR #5 merged (two Bugbot findings fixed first); heartbeat build deployed 1:52 PM CDT via a live test of the watchdog's real recovery path. Heartbeat code is confirmed in the loaded bundle. While traffic is continuous, each delivery counts as the heartbeat, so `checkpoint ok` rows show up only after 5 idle min.
- [x] Task "Discord Collector Watchdog" registered (every 15 min + at logon, headless); first run result 0, state `ok`. The watchdog state file was reset after the deploy test.

_Last updated: 2026-10-29 2:10 PM CDT_
---

# HANDOFF (round 3, Oct 29, 2026): Bugbot follow-ups, 5-minute watchdog cooldown, resume notice

Ethan's email liaison passed on four Cursor Bugbot findings from PRs #3 and #5 and asked which were already fixed. His instructions: make the watchdog cooldown about 5 minutes instead of 60; fix the stale `discordRunning` in the health file if it is still there; fix the panel hiding the "resuming automatically at ..." notice; fix `enable` keeping an old scheduled resume. The goal is that a collector outage heals quickly and the panel tells him honestly when capture will come back. Same rules as before: a new branch and PR off `expanded-capture-readonly`, no merge and no deploy until Ethan approves, AETERNUM and its scheduled tasks are not touched, and secrets are referenced by path only (`C:\Users\Estid\AppData\Local\PersonalCoordination\<app>.secret`, OS-protected plugin storage).

**Status of each finding**
1. **PR #5 HIGH, "cooldown starts after a failed relaunch":** already fixed before PR #5 merged, in commit `e72aa58` (now on `expanded-capture-readonly`). A failed relaunch sets no cooldown and is reported as `recovery-failed`. This round: the default cooldown is now **5 min** (`-CooldownMinutes`, still configurable). RepairVencord's exit code is checked and logged. Success now requires a **fresh** Discord process, started after the recovery began, that is still running about 10 s later. Before, any leftover Discord process counted as success. Failures still count toward the 3-strike `needs-attention` stop.
2. **PR #5 LOW, "health file keeps stale Discord status":** already fixed in `40b06af` (on `expanded-capture-readonly`). Discord is observed again after recovery and before the health file is written. This round adds a regression test.
3. **PR #3 MEDIUM, "panel hides scheduled resume notice":** was still present; now fixed. The panel line comes from `alwaysOnNotice()` in `src/core/always-on.ts`. When a resume is scheduled, it shows the stop reason and resume time instead of the generic "paused" text.
4. **PR #3 LOW, "enable leaves stale resume timestamp":** was still present; now fixed. A successful `enable` clears `resumeAt`, so the next stop starts the backoff fresh at 1 min. There is no separate timer to clear, because resume is driven by the plugin's 1-second poll.

Also hardened in the watchdog: timestamps parse correctly under PowerShell 7 as well as 5.1, and a state file that is missing a field no longer aborts the run.

**Behavior change to flag:** the scheduled task runs every 15 min, so a 5-min cooldown means a still-dead capture is retried on the next run instead of waiting an hour. Each retry restarts Discord, which drops a voice call. It still stops after 3 recoveries that don't restore health (`needs-attention`).

## Checklist (round 3)
- [x] Checked each finding against `expanded-capture-readonly` (#1 and #2 already fixed in `e72aa58` and `40b06af`; #3 and #4 were still present)
- [x] Watchdog: 5-min default cooldown, exit-code check, fresh-process confirmation, PS7 timestamp fix, state-file hardening
- [x] Panel resume notice (#3) and enable clearing `resumeAt` (#4)
- [x] Tests: `tests/always-on.test.ts` (+2) and new `tests/watchdog.test.ts` (9 tests; behavioral tests run the real script under `pwsh` with every process and network call mocked, and skip when `pwsh` is missing). `npm run check` passes 90/90 with `pwsh` installed
- [ ] Left for Ethan: review and merge the PR into `expanded-capture-readonly`
- [ ] After approval: copy `scripts/windows/CollectorWatchdog.ps1` to `C:\automation\Vencord\CollectorWatchdog.ps1` (the scheduled task picks it up on its next run), and rebuild Vencord with the plugin through `RepairVencord.ps1` so the panel and enable fixes load

_Last updated: 2026-10-29 7:21 PM CDT_
