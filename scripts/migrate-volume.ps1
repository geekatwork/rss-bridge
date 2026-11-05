[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OldVolume,
  [Parameter(Mandatory = $true)][string]$NewVolume,
  [Parameter(Mandatory = $true)][string]$BackupDirectory,
  [Parameter(Mandatory = $true)][string]$DatabaseUser,
  [Parameter(Mandatory = $true)][string]$DatabaseName,
  [string]$PostgresImage = "postgres:16-alpine"
)

$ErrorActionPreference = "Stop"

function Invoke-Docker {
  param([string[]]$DockerArguments)
  $output = & docker @DockerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Docker command failed (exit $LASTEXITCODE): $($DockerArguments[0])"
  }
  return $output
}

if ($OldVolume -eq $NewVolume) { throw "Source and destination volumes must differ" }
foreach ($volume in @($OldVolume, $NewVolume)) {
  if ($volume -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]+$') { throw "Invalid volume name" }
}
if ($PostgresImage -ne "postgres:16-alpine") {
  throw "Only PostgreSQL 16 is supported. Major-version upgrades require logical dump/restore."
}
if (-not [System.IO.Path]::IsPathRooted($BackupDirectory) -or $BackupDirectory.Contains(",")) {
  throw "BackupDirectory must be an absolute Docker-host path without commas"
}

$null = Invoke-Docker @("volume", "inspect", $OldVolume)
$volumes = @(Invoke-Docker @("volume", "ls", "--format", "{{.Name}}"))
foreach ($volume in @($OldVolume, $NewVolume)) {
  $active = @(Invoke-Docker @("ps", "-q", "--filter", "volume=$volume"))
  if ($active.Count -gt 0) {
    throw "Volume '$volume' is in use. Stop all attached containers successfully before migrating."
  }
}

$sourceMount = "type=volume,src=$OldVolume,dst=/from,readonly"
$destinationMount = "type=volume,src=$NewVolume,dst=/to"
if ($volumes -contains $NewVolume) {
  $null = Invoke-Docker @("run", "--rm", "--network", "none", "--mount", "$destinationMount,readonly",
    "--entrypoint", "sh", $PostgresImage, "-ec",
    'test -z "$(ls -A /to)" || { echo "Destination is not empty; refusing overlay" >&2; exit 1; }')
}

$null = Invoke-Docker @("run", "--rm", "--network", "none", "--mount", $sourceMount,
  "--entrypoint", "sh", $PostgresImage, "-ec", @'
test "$(cat /from/PG_VERSION)" = 16 || { echo "Source must be a PostgreSQL 16 cluster" >&2; exit 1; }
test ! -e /from/postmaster.pid || { echo "Source postmaster.pid exists; verify clean shutdown" >&2; exit 1; }
test -z "$(find /from -type l -print -quit)" || { echo "Symlinked storage requires a separate migration procedure" >&2; exit 1; }
LC_ALL=C pg_controldata /from | grep -Eq '^Database cluster state: +shut down$' || { echo "Source cluster is not cleanly shut down" >&2; exit 1; }
'@)

$backupName = "postgres16-$([guid]::NewGuid().ToString('N')).tar.gz"
$backupMount = "type=bind,src=$BackupDirectory,dst=/backup"
Write-Host "Creating private offline backup: $BackupDirectory/$backupName"
$null = Invoke-Docker @("run", "--rm", "--network", "none", "--mount", $sourceMount,
  "--mount", $backupMount, "--entrypoint", "sh", $PostgresImage, "-ec", @'
umask 077
set -C
tar -cz -C /from . > "/backup/$1"
gzip -t "/backup/$1"
tar -tzf "/backup/$1" >/dev/null
'@, "sh", $backupName)

if ($volumes -notcontains $NewVolume) {
  $null = Invoke-Docker @("volume", "create", $NewVolume)
}

# Recheck immediately before copying; operators must keep writers stopped throughout.
foreach ($volume in @($OldVolume, $NewVolume)) {
  if (@(Invoke-Docker @("ps", "-q", "--filter", "volume=$volume")).Count -gt 0) {
    throw "Volume '$volume' became active; refusing copy"
  }
}
Write-Host "Copying into empty destination and comparing every regular file..."
$null = Invoke-Docker @("run", "--rm", "--network", "none", "--mount", $sourceMount,
  "--mount", $destinationMount, "--entrypoint", "sh", $PostgresImage, "-ec", @'
test -z "$(ls -A /to)" || { echo "Destination is not empty; refusing overlay" >&2; exit 1; }
cp -a /from/. /to/
set -o pipefail
(cd /from && find . -type f -exec sha256sum {} \; | sort) > /tmp/source.sha256
(cd /to && find . -type f -exec sha256sum {} \; | sort) > /tmp/destination.sha256
cmp /tmp/source.sha256 /tmp/destination.sha256
'@)

$verifier = "rss-bridge-volume-check-$([guid]::NewGuid().ToString('N'))"
$created = $false
try {
  $null = Invoke-Docker @("create", "--name", $verifier, "--network", "none",
    "--mount", "type=volume,src=$NewVolume,dst=/var/lib/postgresql/data",
    $PostgresImage, "postgres", "-c", "listen_addresses=")
  $created = $true
  $null = Invoke-Docker @("start", $verifier)
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $state = Invoke-Docker @("inspect", "-f", "{{.State.Running}}", $verifier)
    if ($state -ne "true") { throw "Verification PostgreSQL exited before readiness" }
    # Readiness is an expected retryable nonzero result, not a migration failure.
    & docker exec $verifier pg_isready -U $DatabaseUser -d $DatabaseName
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "Timed out waiting for verification PostgreSQL" }
  $null = Invoke-Docker @("exec", $verifier, "pg_amcheck", "--all", "--install-missing", "--username=$DatabaseUser")
  $null = Invoke-Docker @("exec", $verifier, "psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-U", $DatabaseUser, "-d", $DatabaseName, "-c",
    "SELECT count(*) AS groups FROM groups; SELECT count(*) AS posts FROM posts;")
  $null = Invoke-Docker @("stop", "--time", "60", $verifier)
  if ((Invoke-Docker @("inspect", "-f", "{{.State.ExitCode}}", $verifier)) -ne "0") {
    throw "Verification PostgreSQL did not stop cleanly"
  }
} finally {
  if ($created) { $null = Invoke-Docker @("rm", "-f", $verifier) }
}

Write-Host "Migration verified. Both volumes and backup retained. Production services remain stopped."
Write-Host "Verify application behavior after deliberate cutover. Do not remove the source volume."
