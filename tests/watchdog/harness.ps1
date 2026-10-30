# Test harness for scripts/windows/CollectorWatchdog.ps1 (run by tests/watchdog.test.ts under pwsh).
# Mocks every process/network side effect as global functions (functions win over cmdlets), then runs a copy
# of the watchdog whose only edits point node and RepairVencord.ps1 at harmless local stand-ins.
param([string]$Script, [string]$Scenario)
$ErrorActionPreference = 'Stop'
$sc = Get-Content $Scenario -Raw | ConvertFrom-Json
$global:MockProcs = [System.Collections.ArrayList]::new()
if ($sc.discordRunning) { [void]$global:MockProcs.Add([pscustomobject]@{ Name = 'Discord'; Path = 'C:\x\app-1.0.9266\Discord.exe'; StartTime = (Get-Date).AddHours(-5) }) }
$global:MockSc = $sc
$global:MockCalls = [System.Collections.ArrayList]::new()
function global:Get-Process { param([string]$Name, $ErrorAction) @($global:MockProcs | Where-Object { $_.Name -eq $Name }) }
function global:Stop-Process { param([Parameter(ValueFromPipeline = $true)]$InputObject, [switch]$Force)
    process { [void]$global:MockCalls.Add('stop'); if (-not $global:MockSc.stopFails) { $global:MockProcs.Remove($InputObject) } } }
function global:Start-Sleep { param($Seconds) }
function global:Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) if ($global:MockSc.receiverListening -ne $false) { [pscustomobject]@{ LocalPort = $LocalPort } } }
function global:Start-Process { param($FilePath, $ArgumentList, $ErrorAction)
    [void]$global:MockCalls.Add('update')
    if ($global:MockSc.updateThrows) { throw 'Update.exe not found' }
    if ($global:MockSc.updateStarts) { [void]$global:MockProcs.Add([pscustomobject]@{ Name = 'Discord'; Path = 'C:\x\app-1.0.9266\Discord.exe'; StartTime = Get-Date }) } }
function global:powershell.exe {
    [void]$global:MockCalls.Add('repair')
    if ($global:MockSc.repairThrows) { throw 'RepairVencord blew up' }
    if ($global:MockSc.repairStarts) { [void]$global:MockProcs.Add([pscustomobject]@{ Name = 'Discord'; Path = 'C:\x\app-1.0.9266\Discord.exe'; StartTime = Get-Date }) }
    $global:LASTEXITCODE = [int]$global:MockSc.repairExit }

$dir = Split-Path -Parent $Scenario
$copy = Join-Path $dir 'CollectorWatchdog.ps1'
$src = Get-Content $Script -Raw
$src = $src.Replace("`$node     = 'C:\Program Files\nodejs\node.exe'", "`$node     = 'node'")
$src = $src.Replace("`$repair   = 'C:\automation\Vencord\RepairVencord.ps1'", "`$repair   = Join-Path `$here 'RepairVencord.ps1'")
Set-Content -Path $copy -Value $src
Set-Content -Path (Join-Path $dir 'RepairVencord.ps1') -Value '# stand-in'
Set-Content -Path (Join-Path $dir 'collector-health-query.cjs') -Value ('process.stdout.write(' + ($sc.query | ConvertTo-Json -Compress -Depth 3 | ConvertTo-Json) + ')')
$env:LOCALAPPDATA = $dir
$pcm = Join-Path $dir 'PersonalCoordination'; New-Item -ItemType Directory -Force $pcm | Out-Null
if ($sc.state) { $sc.state | ConvertTo-Json | Set-Content (Join-Path $pcm 'collector-watchdog-state.json') }
$params = @{}; if ($sc.params) { foreach ($p in $sc.params.PSObject.Properties) { $params[$p.Name] = $p.Value } }
& $copy @params
[pscustomobject]@{
    health = Get-Content (Join-Path $pcm 'collector-health.json') -Raw | ConvertFrom-Json
    state = Get-Content (Join-Path $pcm 'collector-watchdog-state.json') -Raw | ConvertFrom-Json
    calls = @($global:MockCalls)
    log = Get-Content (Join-Path (Join-Path $pcm 'logs') 'collector-watchdog.log') -Raw
} | ConvertTo-Json -Depth 5 -Compress
