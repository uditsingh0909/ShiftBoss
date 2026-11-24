#!/usr/bin/env bash
# Keeps Foreman up: restarts it 3 seconds after it exits, logging each start.
# Usage: bash scripts/run.sh   (from the foreman folder)
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
while true; do
  echo "$(date -u +%FT%TZ) starting Foreman" >> data/server.log
  bun server/index.ts >> data/server.log 2>&1
  echo "$(date -u +%FT%TZ) Foreman exited with $?; restarting in 3 s" >> data/server.log
  sleep 3
done
