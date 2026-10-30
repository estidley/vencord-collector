import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Behavioral tests for scripts/windows/CollectorWatchdog.ps1 under PowerShell 7 with every process and network
// side effect mocked (tests/watchdog/harness.ps1). Skipped when pwsh is not installed (GitHub's ubuntu runners have it).
const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "windows", "CollectorWatchdog.ps1");
const harness = join(root, "tests", "watchdog", "harness.ps1");
const pwsh = process.env.PWSH ?? "pwsh";
const hasPwsh = spawnSync(pwsh, ["-NoProfile", "-Command", "exit 0"]).status === 0;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const staleQuery = { ok: true, lastIngestAt: minutesAgo(90), lastHeartbeatAt: minutesAgo(45) };

type Run = { health: Record<string, any>; state: Record<string, any>; calls: string[]; log: string };
function run(scenario: Record<string, unknown>): Run {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-"));
    try {
        const file = join(dir, "scenario.json"); writeFileSync(file, JSON.stringify({ query: staleQuery, discordRunning: true, repairExit: 0, ...scenario }));
        const out = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", harness, "-Script", script, "-Scenario", file], { encoding: "utf8" });
        assert.equal(out.status, 0, out.stderr);
        const result = JSON.parse(out.stdout.trim().split("\n").at(-1)!) as Run;
        result.calls = [result.calls].flat().filter(Boolean) as string[];
        return result;
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
const opts = { skip: hasPwsh ? false : "pwsh not installed" };

test("watchdog: healthy capture takes no action", opts, () => {
    const r = run({ query: { ok: true, lastIngestAt: minutesAgo(2), lastHeartbeatAt: minutesAgo(1) } });
    assert.equal(r.health.state, "ok"); assert.equal(r.health.recoveryActionThisRun, null); assert.deepEqual(r.calls, []);
});

test("watchdog: a confirmed relaunch records success and starts the default 5-minute cooldown", opts, () => {
    const r = run({ repairStarts: true });
    assert.equal(r.health.state, "recovering"); assert.equal(r.health.discordRunning, true);
    assert.match(r.health.recoveryActionThisRun, /restarted Discord via RepairVencord\.ps1/);
    assert.ok(r.state.lastRecoveryAt); assert.equal(r.state.consecutiveRecoveries, 1);
    assert.deepEqual(r.calls, ["stop", "repair"]);
});

test("watchdog: a failed relaunch is never recorded as success and sets no cooldown (Bugbot HIGH)", opts, () => {
    const r = run({ repairExit: 1, updateThrows: true, state: { lastRecoveryAt: minutesAgo(30), consecutiveRecoveries: 1, lastRecoveryAction: "x" } });
    assert.equal(r.health.state, "recovery-failed"); assert.equal(r.state.lastRecoveryAt, null);
    assert.equal(r.state.consecutiveRecoveries, 2, "failures count toward needs-attention");
    assert.match(r.log, /RepairVencord\.ps1 did not report success \(exit=1\)/); assert.match(r.log, /Update\.exe launch failed/);
    assert.deepEqual(r.calls, ["stop", "repair", "update"]);
});

test("watchdog: health reports Discord as observed after a failed recovery, not the pre-recovery snapshot (Bugbot LOW)", opts, () => {
    const r = run({ repairExit: 0 });
    assert.equal(r.health.state, "recovery-failed"); assert.equal(r.health.discordRunning, false); assert.equal(r.health.discordVersion, null);
});

test("watchdog: a Discord process left over from before the stop does not count as relaunched", opts, () => {
    const r = run({ stopFails: true, repairExit: 0 });
    assert.equal(r.health.state, "recovery-failed"); assert.equal(r.state.lastRecoveryAt, null);
});

test("watchdog: RepairVencord throwing falls back to Update.exe and is confirmed by the process check", opts, () => {
    const r = run({ repairThrows: true, updateStarts: true });
    assert.equal(r.health.state, "recovering"); assert.match(r.health.recoveryActionThisRun, /via Update\.exe/);
    assert.match(r.log, /RepairVencord\.ps1 threw/);
});

test("watchdog: cooldown defaults to 5 minutes and stays configurable", opts, () => {
    assert.equal(run({ state: { lastRecoveryAt: minutesAgo(4), consecutiveRecoveries: 1 } }).health.recoveryActionThisRun.startsWith("waiting (cooldown"), true);
    assert.equal(run({ repairStarts: true, state: { lastRecoveryAt: minutesAgo(6), consecutiveRecoveries: 1 } }).health.state, "recovering");
    assert.equal(run({ params: { CooldownMinutes: 60 }, state: { lastRecoveryAt: minutesAgo(30), consecutiveRecoveries: 1 } }).health.recoveryActionThisRun.startsWith("waiting (cooldown"), true);
});

test("watchdog: three recoveries without regaining health stop auto-restart and ask for a person", opts, () => {
    const r = run({ state: { lastRecoveryAt: null, consecutiveRecoveries: 3 } });
    assert.equal(r.health.state, "needs-attention"); assert.deepEqual(r.calls, []);
});

test("watchdog script keeps its 5-minute default cooldown", () => {
    assert.match(readFileSync(script, "utf8"), /\[int\]\$CooldownMinutes = 5,/);
});
