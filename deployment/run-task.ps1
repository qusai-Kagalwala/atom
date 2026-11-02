<#
  ATOM - runs one background script and keeps its log. Called by the scheduled tasks that
  install-tasks.ps1 creates; you can also run it by hand:
    powershell -NoProfile -ExecutionPolicy Bypass -File deployment\run-task.ps1 -Name jobs
  Names: jobs | people | occupancy | items
  Log: <ATOM folder>\logs\<name>-<yyyy-MM>.log (one file per month; files older than 90 days are removed).
  Exit code: the script's own (0 = ok, 2 = blocked by a guard, 1 = failed).
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('jobs', 'people', 'occupancy', 'items')]
  [string]$Name
)

$ErrorActionPreference = 'Stop'
$scripts = @{
  jobs      = 'sync\run-jobs.js'
  people    = 'sync\run-idarah-sync.js'
  occupancy = 'sync\run-occupancy-sync.js'
  items     = 'sync\run-items-sync.js'
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ('{0}-{1}.log' -f $Name, (Get-Date -Format 'yyyy-MM'))

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $node)) {
  Add-Content -Path $log -Value ('[{0}] node.exe not found' -f (Get-Date -Format s))
  exit 1
}

# Node writes its own timestamps; stderr and stdout both go to the log.
$ErrorActionPreference = 'Continue'
& $node $scripts[$Name] 2>&1 | ForEach-Object { "$_" } | Add-Content -Path $log -Encoding UTF8
$code = $LASTEXITCODE

Get-ChildItem -Path $logDir -Filter '*.log' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } |
  Remove-Item -Force -ErrorAction SilentlyContinue

exit $code
