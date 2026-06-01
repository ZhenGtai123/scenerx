#!/usr/bin/env bash
# Cross-platform "up" wrapper for users without `make`.
# Creates .env from .env.example if missing, brings the stack up
# detached, then prints the URLs the user should open.
set -e

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env created from .env.example."
fi

ARGS=("$@")
PROFILE_GPU=""
for arg in "${ARGS[@]}"; do
  if [ "$arg" = "--gpu" ] || [ "$arg" = "--profile" ]; then
    PROFILE_GPU="--profile gpu"
  fi
done

if [ -n "$PROFILE_GPU" ]; then
  docker compose --profile gpu up -d
else
  docker compose up -d
fi

echo ""
echo "  Frontend:    http://localhost:3000"
echo "  Backend:     http://localhost:8080"
echo "  Settings UI: http://localhost:3000/settings"
if [ -n "$PROFILE_GPU" ]; then
  echo "  Vision API:  http://localhost:8000"
fi
echo ""
echo "Tail logs:   docker compose logs -f"
echo "Stop stack:  docker compose down"
