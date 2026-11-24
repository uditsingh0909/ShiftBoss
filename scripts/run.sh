#!/usr/bin/env bash
# Keeps Foreman up: restarts it 3 seconds after it exits, logging each start.
# Usage: bash scripts/run.sh   (from the foreman folder; Windows startup runs it hidden)
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
PORT="${FOREMAN_PORT:-4400}"
# Already running (another loop, or started by hand): leave it alone.
if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"; then
  echo "$(date -u +%FT%TZ) Foreman already answering on ${PORT}; not starting a second copy" >> data/server.log
  exit 0
fi
while true; do
  echo "$(date -u +%FT%TZ) starting Foreman" >> data/server.log
  bun server/index.ts >> data/server.log 2>&1
  code=$?
  # Someone else took the port while we were down: stop looping.
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"; then exit 0; fi
  echo "$(date -u +%FT%TZ) Foreman exited with ${code}; restarting in 3 s" >> data/server.log
  sleep 3
done
