# CollectorWatchdog.ps1 - keeps a Vencord Collector outage from going silent.
# Runs every 15 minutes from the "Discord Collector Watchdog" scheduled task (as the logged-on user).
#
# Health signal: the personal-coordination-mcp receiver's plaintext audit timestamps, read read-only.
#   - "ingest ok"      = the collector delivered records
#   - "checkpoint ok"  = the collector's heartbeat (sent every 5 min while capture is running, even when idle)
# The heartbeat stops the moment capture stops, so a long silence means capture is off, not just a quiet chat.
# This script never reads message payloads, tokens or keys, and never deletes anything.
#
# Writes:  %LOCALAPPDATA%\PersonalCoordination\collector-health.json   (current status, read this remotely)
#          %LOCALAPPDATA%\PersonalCoordination\logs\collector-watchdog.log (one line per check)
param(
    [int]$StaleMinutes = 20,          # 4x the 5-min heartbeat; also longer than the plugin's own 15-min max self-resume
    [int]$CooldownMinutes = 60,       # at most one recovery per hour
    [int]$MaxRecoveries = 3,          # consecutive recoveries without regaining health before we stop and ask for help
    [switch]$NoRestart                # report only; never stop/start Discord
)
$ErrorActionPreference = 'Continue'
$pcm      = Join-Path $env:LOCALAPPDATA 'PersonalCoordination'
$db       = Join-Path $pcm 'data\messages.sqlite'
$health   = Join-Path $pcm 'collector-health.json'
$stateF   = Join-Path $pcm 'collector-watchdog-state.json'
$logDir   = Join-Path $pcm 'logs'
$log      = Join-Path $logDir 'collector-watchdog.log'
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$query    = Join-Path $here 'collector-health-query.cjs'
$repair   = 'C:\automation\Vencord\RepairVencord.ps1'
$updater  = Join-Path $env:LOCALAPPDATA 'Discord\Update.exe'
$node     = 'C:\Program Files\nodejs\node.exe'
$port     = 4320

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') - $m" | Out-File -Append -Encoding utf8 $log }
function Iso($d) { if ($d) { $d.ToString('o') } else { $null } }
function Wait-Discord([int]$seconds) {
    for ($i = 0; $i -lt $seconds; $i += 3) { if (Get-Process -Name Discord -ErrorAction SilentlyContinue) { return $true }; Start-Sleep 3 }
    return [bool](Get-Process -Name Discord -ErrorAction SilentlyContinue)
}
function ParseUtc($s) { if ($s) { [DateTimeOffset]::Parse($s).LocalDateTime } else { $null } }

$mutex = New-Object System.Threading.Mutex($false, 'Global\EthanCollectorWatchdog')
if (-not $mutex.WaitOne(0)) { Log 'Another watchdog run is in progress - exiting'; exit }
try {
    $now = Get-Date
    # ---- persisted recovery counters (our own small file) ----
    $st = [pscustomobject]@{ lastRecoveryAt = $null; consecutiveRecoveries = 0; lastRecoveryAction = $null }
    if (Test-Path $stateF) { try { $st = Get-Content $stateF -Raw | ConvertFrom-Json } catch {} }
    $lastRecovery = ParseUtc $st.lastRecoveryAt

    # ---- observe ----
    $discord   = @(Get-Process -Name Discord -ErrorAction SilentlyContinue)
    $running   = $discord.Count -gt 0
    $discordVer = $null
    if ($running) { $p = ($discord | Where-Object { $_.Path } | Select-Object -First 1).Path; if ($p -match 'app-([0-9.]+)') { $discordVer = $Matches[1] } }
    $listening = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

    $q = $null
    try { $q = (& $node --no-warnings $query $db 2>$null) | ConvertFrom-Json } catch {}
    $lastIngest = $null; $lastBeat = $null; $dbOk = $false
    if ($q -and $q.ok) { $dbOk = $true; $lastIngest = ParseUtc $q.lastIngestAt; $lastBeat = ParseUtc $q.lastHeartbeatAt }
    $lastSignal = @($lastIngest, $lastBeat | Where-Object { $_ }) | Sort-Object | Select-Object -Last 1
    $mins = $null; if ($lastSignal) { $mins = [math]::Round(($now - $lastSignal).TotalMinutes, 1) }
    $stale = (-not $lastSignal) -or ($mins -gt $StaleMinutes)

    # ---- classify ----
    if (-not $dbOk)           { $state = 'unknown';             $msg = 'Could not read the receiver audit log.' }
    elseif (-not $listening)  { $state = 'receiver-down';       $msg = "Receiver is not listening on 127.0.0.1:$port. Its own supervisor task restarts it; Discord left alone." }
    elseif (-not $running)    { $state = 'discord-not-running'; $msg = 'Discord is not running, so nothing is being captured.' }
    elseif ($stale)           { $state = 'stale';               $msg = "Discord is running but nothing (no ingest, no heartbeat) for $mins min (threshold $StaleMinutes)." }
    else                      { $state = 'ok';                  $msg = "Capture alive. Last signal $mins min ago." }

    $healthy = ($state -eq 'ok')
    if ($healthy) { $st.consecutiveRecoveries = 0 }

    # ---- recover (only for states Discord can fix) ----
    $action = $null
    if ($state -in @('stale', 'discord-not-running')) {
        $cool = (-not $lastRecovery) -or (($now - $lastRecovery).TotalMinutes -ge $CooldownMinutes)
        if ($NoRestart) { $action = 'none (NoRestart)' }
        elseif ([int]$st.consecutiveRecoveries -ge $MaxRecoveries) {
            $state = 'needs-attention'
            $msg = "$msg Auto-recovery tried $($st.consecutiveRecoveries) times without success; stopped restarting. Needs a person."
            $action = 'none (recoveries exhausted)'
        }
        elseif (-not $cool) { $action = "waiting (cooldown, last recovery $(Iso $lastRecovery))" }
        else {
            if ($running) { Log "RECOVER: stopping Discord ($state)"; $discord | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 4 }
            # RepairVencord re-patches the newest Discord onto the custom build if an update wiped it, then launches Discord.
            # Native-command failures do not throw, so never trust the launch: confirm Discord is actually back.
            $via = $null
            if (Test-Path $repair) {
                Log 'RECOVER: running RepairVencord.ps1 (re-patch if needed, then launch Discord)'
                try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $repair | Out-Null } catch { Log "WARN RepairVencord.ps1 threw: $_" }
                if (Wait-Discord 60) { $via = 'RepairVencord.ps1' } else { Log "WARN RepairVencord.ps1 exit=$LASTEXITCODE but Discord did not start; trying Update.exe" }
            }
            if (-not $via) {
                try { Start-Process $updater -ArgumentList '--processStart Discord.exe' -ErrorAction Stop } catch { Log "WARN Update.exe launch failed: $_" }
                if (Wait-Discord 45) { $via = 'Update.exe' }
            }
            $st.consecutiveRecoveries = [int]$st.consecutiveRecoveries + 1
            if ($via) {
                # Only a confirmed relaunch starts the cooldown, giving the plugin time to restore and heartbeat.
                $action = "restarted Discord via $via"
                $st.lastRecoveryAt = Iso (Get-Date); $st.lastRecoveryAction = $action
                $state = 'recovering'; $msg = "$msg Recovery: $action (confirmed running)."
            } else {
                # Discord is down and we could not bring it back. No cooldown, so the next run retries;
                # consecutiveRecoveries still climbs so this ends in needs-attention instead of looping forever.
                $action = 'relaunch FAILED (Discord not running after RepairVencord.ps1 and Update.exe)'
                $st.lastRecoveryAction = $action; $st.lastRecoveryAt = $null   # clear any cooldown: next run must retry
                $state = 'recovery-failed'; $msg = "$msg Recovery failed: Discord did not start. Will retry next run."
                Log "ERROR $action"
            }
        }
    }

    # Re-observe Discord AFTER any recovery so the health file reports what is true now, not the pre-recovery snapshot.
    $discord = @(Get-Process -Name Discord -ErrorAction SilentlyContinue); $running = $discord.Count -gt 0; $discordVer = $null
    if ($running) { $p = ($discord | Where-Object { $_.Path } | Select-Object -First 1).Path; if ($p -match 'app-([0-9.]+)') { $discordVer = $Matches[1] } }

    $out = [ordered]@{
        schema = 1
        checkedAt = Iso $now
        healthy = $healthy
        state = $state            # ok | stale | recovering | recovery-failed | discord-not-running | receiver-down | needs-attention | unknown
        message = $msg
        discordRunning = $running
        discordVersion = $discordVer
        receiverListening = $listening
        lastIngestAt = Iso $lastIngest
        lastHeartbeatAt = Iso $lastBeat
        lastSignalAt = Iso $lastSignal
        minutesSinceSignal = $mins
        staleThresholdMinutes = $StaleMinutes
        checkIntervalMinutes = 15
        autoRestart = (-not $NoRestart)
        lastRecoveryAt = $st.lastRecoveryAt
        lastRecoveryAction = $st.lastRecoveryAction
        consecutiveRecoveries = [int]$st.consecutiveRecoveries
        recoveryActionThisRun = $action
    }
    # Atomic-ish write: temp file then replace (our own generated files only).
    $tmp = "$health.tmp"; ($out | ConvertTo-Json -Depth 4) | Set-Content -Encoding utf8 $tmp; Move-Item -Force $tmp $health
    $st | ConvertTo-Json | Set-Content -Encoding utf8 $stateF
    Log "$state healthy=$healthy signal=$mins min discord=$running($discordVer) receiver=$listening action=$action"
} catch {
    Log "ERROR watchdog: $_"
} finally { $mutex.ReleaseMutex() }
