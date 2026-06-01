# Cross-platform "up" wrapper for Windows users without `make`.
# Creates .env from .env.example if missing, brings the stack up
# detached, then prints the URLs the user should open.
#
# Usage:
#   .\start.ps1            # CPU-only stack (set VISION_API_URL via Settings UI)
#   .\start.ps1 -Gpu       # also runs local vision-api (needs NVIDIA GPU)

param([switch]$Gpu)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host ".env created from .env.example."
}

if ($Gpu) {
    docker compose --profile gpu up -d
} else {
    docker compose up -d
}

Write-Host ""
Write-Host "  Frontend:    http://localhost:3000"
Write-Host "  Backend:     http://localhost:8080"
Write-Host "  Settings UI: http://localhost:3000/settings"
if ($Gpu) {
    Write-Host "  Vision API:  http://localhost:8000"
}
Write-Host ""
Write-Host "Tail logs:   docker compose logs -f"
Write-Host "Stop stack:  docker compose down"
