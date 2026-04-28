$ErrorActionPreference = "Stop"

$OldVolume = "fb-to-rss_pgdata"
$NewVolume = "rss-bridge_pgdata"
$DbContainer = "rss-bridge-db"

Write-Host "Stopping compose stack..."
docker compose down

$oldExists = docker volume ls -q --filter "name=^$OldVolume$"
if (-not $oldExists) {
  Write-Host "Old volume '$OldVolume' not found. Nothing to migrate."
  Write-Host "Starting compose stack..."
  docker compose up -d
  exit 0
}

$newExists = docker volume ls -q --filter "name=^$NewVolume$"
if (-not $newExists) {
  Write-Host "Creating new volume '$NewVolume'..."
  docker volume create $NewVolume | Out-Null
}

Write-Host "Copying data from '$OldVolume' to '$NewVolume'..."
docker run --rm -v "${OldVolume}:/from" -v "${NewVolume}:/to" alpine sh -c "cd /from && cp -a . /to"

Write-Host "Starting compose stack..."
docker compose up -d

Write-Host "Verifying DB container mounts..."
docker inspect $DbContainer --format "{{range .Mounts}}{{.Name}} -> {{.Destination}}{{println}}{{end}}"

Write-Host "Migration complete."
Write-Host "If everything looks correct, remove old volume with: docker volume rm $OldVolume"
