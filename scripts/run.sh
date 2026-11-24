#!/usr/bin/env bash
# Keeps Shiftboss up: restarts it 3 seconds after it exits, logging each start.
# Usage: bash scripts/run.sh   (from the shiftboss folder; Windows startup runs it hidden)
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
PORT="${SHIFTBOSS_PORT:-4400}"
# Already running (another loop, or started by hand): leave it alone.
if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"; then
  echo "$(date -u +%FT%TZ) Shiftboss already answering on ${PORT}; not starting a second copy" >> data/server.log
  exit 0
fi
while true; do
  echo "$(date -u +%FT%TZ) starting Shiftboss" >> data/server.log
  bun server/index.ts >> data/server.log 2>&1
  code=$?
  # Someone else took the port while we were down: stop looping.
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"; then exit 0; fi
  echo "$(date -u +%FT%TZ) Shiftboss exited with ${code}; restarting in 3 s" >> data/server.log
  sleep 3
done
