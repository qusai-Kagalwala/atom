<#
  ATOM - creates (or updates) the Windows Task Scheduler tasks, in the Task Scheduler folder \ATOM\.
  Run once on the server, in PowerShell as Administrator, from the ATOM folder:
    powershell -NoProfile -ExecutionPolicy Bypass -File deployment\install-tasks.ps1
  It asks for the Windows account the tasks run as (needs: read the ATOM folder and .env, write
  ATOM\logs and ATTACHMENT_DIR, reach PostgreSQL / SQL Server / SMTP / the internet).
  Tasks run whether or not anyone is signed in.

    ATOM Jobs        every 5 minutes   overdue alerts, notification emails, email log clean-up
    ATOM People      every 10 minutes  Idarah view + HR view sync
    ATOM Occupancy   daily 06:00       room occupancy sheet
    ATOM Items       nightly 02:00     Support Log item lists

  Remove them all:  ...\install-tasks.ps1 -Remove
  Logs:             <ATOM folder>\logs\<jobs|people|occupancy|items>-<yyyy-MM>.log
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$folder = '\ATOM\'
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-task.ps1'

$tasks = @(
  @{ Task = 'ATOM Jobs';      Name = 'jobs';      Every = 5;  Limit = 4 },
  @{ Task = 'ATOM People';    Name = 'people';    Every = 10; Limit = 9 },
  @{ Task = 'ATOM Occupancy'; Name = 'occupancy'; At = '06:00'; Limit = 30 },
  @{ Task = 'ATOM Items';     Name = 'items';     At = '02:00'; Limit = 60 }
)

if ($Remove) {
  foreach ($t in $tasks) {
    if (Get-ScheduledTask -TaskPath $folder -TaskName $t.Task -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskPath $folder -TaskName $t.Task -Confirm:$false
      Write-Host "Removed $($t.Task)"
    }
  }
  return
}

if (-not (Test-Path (Join-Path $root '.env'))) { throw "No .env in $root - create it first." }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $env:ProgramFiles 'nodejs\node.exe'))) {
  throw 'node.exe not found. Install Node.js first.'
}

$cred = Get-Credential -Message 'Windows account the ATOM tasks run as (DOMAIN\user or .\user)'
if (-not $cred) { throw 'No account given.' }
$user = $cred.UserName
$password = $cred.GetNetworkCredential().Password

foreach ($t in $tasks) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Name {1}' -f $runner, $t.Name) `
    -WorkingDirectory $root

  if ($t.Every) {
    # Starts a minute from now and repeats for ever.
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $t.Every)
  } else {
    $trigger = New-ScheduledTaskTrigger -Daily -At $t.At
  }

  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes $t.Limit)

  Register-ScheduledTask -TaskPath $folder -TaskName $t.Task `
    -Action $action -Trigger $trigger -Settings $settings `
    -User $user -Password $password -RunLevel Limited -Force | Out-Null
  Write-Host ('Ready: {0}' -f $t.Task)
}

Write-Host ''
Write-Host 'Done. Check: Task Scheduler > Task Scheduler Library > ATOM. First runs start within a minute.'
Write-Host ('Logs: {0}' -f (Join-Path $root 'logs'))
Write-Host 'Run one now: Start-ScheduledTask -TaskPath "\ATOM\" -TaskName "ATOM Jobs"'
