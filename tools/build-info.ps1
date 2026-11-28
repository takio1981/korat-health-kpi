param(
    [ValidateSet('info', 'summary', 'record')][string]$Mode = 'info',
    [long]$Start = 0,
    [string]$Frontend = '',
    [string]$Api = '',
    [string]$Result = ''
)
# Build summary for build.bat (28 Nov 2026)
#   info    : last update (latest commit date/time) + work since last successful deploy
#   summary : info + build time / duration + build status
#   record  : append a line to build-history.log; Result=success also saves .last-deploy
# Dates are shown in Thai Buddhist calendar (th-TH). Code is ASCII only; Thai text comes from git/culture.
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $PSScriptRoot
$th = [Globalization.CultureInfo]'th-TH'
function Fmt($d) { $d.ToString('d MMM yyyy HH:mm:ss', $th) }
function FmtShort($d) { $d.ToString('dd/MM/yy HH:mm', $th) }
function Dur($sec) { if ($sec -lt 60) { "$sec s" } else { '{0} min {1} s' -f [math]::Floor($sec / 60), ($sec % 60) } }
function FromEpoch($s) { [DateTimeOffset]::FromUnixTimeSeconds([long]$s).LocalDateTime }

$now = Get-Date
$hash = (git -C $root rev-parse --short HEAD)
$ct = (git -C $root log -1 --format=%ct)
$subject = (git -C $root log -1 --format=%s)
$branch = (git -C $root rev-parse --abbrev-ref HEAD)
$dirty = @(git -C $root status --porcelain --untracked-files=no).Count
$lastFile = Join-Path $root '.last-deploy'
$histFile = Join-Path $root 'build-history.log'
$last = $null
if (Test-Path $lastFile) {
    $parts = (Get-Content $lastFile -TotalCount 1) -split '\|'
    if ($parts.Count -ge 2) { $last = @{ hash = $parts[0].Trim(); epoch = $parts[1].Trim() } }
}

if ($Mode -eq 'record') {
    $sec = if ($Start -gt 0) { [DateTimeOffset]::Now.ToUnixTimeSeconds() - $Start } else { 0 }
    $line = '{0} | {1} | {2} | {3} | {4}' -f $now.ToString('yyyy-MM-dd HH:mm:ss'), $hash, $Result, (Dur $sec), $subject
    Add-Content -Path $histFile -Value $line -Encoding UTF8
    if ($Result -eq 'success') { Set-Content -Path $lastFile -Value ('{0}|{1}' -f $hash, [DateTimeOffset]::Now.ToUnixTimeSeconds()) -Encoding ASCII }
    Write-Host ('  Recorded to build-history.log : {0}' -f $Result)
    exit 0
}

Write-Host ''
Write-Host '  --- Build information ---'
if ($Mode -eq 'summary' -and $Start -gt 0) {
    $sec = [DateTimeOffset]::Now.ToUnixTimeSeconds() - $Start
    Write-Host ('  Build started  : {0}' -f (Fmt (FromEpoch $Start)))
    Write-Host ('  Build finished : {0}  (took {1})' -f (Fmt $now), (Dur $sec))
} else {
    Write-Host ('  Now            : {0}' -f (Fmt $now))
}
if ($ct) {
    Write-Host ('  Last update    : {0}  [{1}] {2}' -f (Fmt (FromEpoch $ct)), $hash, $subject)
}
Write-Host ('  Branch         : {0}   uncommitted tracked files: {1}' -f $branch, $dirty)
if ($dirty -gt 0) { Write-Host '  [!!] Working tree has uncommitted changes (build uses files on disk)' }

if ($last) {
    Write-Host ('  Last deploy    : {0}  [{1}]' -f (Fmt (FromEpoch $last.epoch)), $last.hash)
    $log = @(git -C $root log --format='%ct|%h|%s' "$($last.hash)..HEAD")
    if ($LASTEXITCODE -ne 0) { $log = @(); Write-Host '  (last deploy commit not found in history)' }
    Write-Host ('  Changes since last deploy: {0} commit(s)' -f $log.Count)
} else {
    Write-Host '  Last deploy    : no record yet (shows latest 5 commits)'
    $log = @(git -C $root log -5 --format='%ct|%h|%s')
}
$show = $log | Select-Object -First 15
foreach ($l in $show) {
    $p = $l -split '\|', 3
    $s = $p[2]; if ($s.Length -gt 90) { $s = $s.Substring(0, 90) + '...' }
    Write-Host ('    - {0}  {1}  {2}' -f (FmtShort (FromEpoch $p[0])), $p[1], $s)
}
if ($log.Count -gt 15) { Write-Host ('    ... and {0} more' -f ($log.Count - 15)) }

if ($Mode -eq 'summary') {
    $f = if ($Frontend -eq '1') { 'OK' } else { 'FAIL' }
    $a = if ($Api -eq '1') { 'OK' } else { 'FAIL' }
    Write-Host ('  Result         : Frontend {0} / API {1}' -f $f, $a)
}
Write-Host ''
