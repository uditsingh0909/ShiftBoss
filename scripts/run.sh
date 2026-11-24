#!/usr/bin/env bash
# Keeps ShiftBoss up: restarts it 3 seconds after it exits, logging each start.
# Usage: bash scripts/run.sh   (from the shiftboss folder; Windows startup runs it hidden)
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
# The port from SHIFTBOSS_PORT, else the config file, else 4400 (shared/port.ts).
PORT="$(bun shared/port.ts 2>/dev/null || echo 4400)"
# Already running (another loop, or started by hand): leave it alone.
if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"; then
  echo "$(date -u +%FT%TZ) ShiftBoss already answering on ${PORT}; not starting a second copy" >> data/server.log
  exit 0
fi
# Open the browser on the first start only; restarts after a crash or an update stay quiet.
OPEN=1
while true; do
  echo "$(date -u +%FT%TZ) starting ShiftBoss" >> data/server.log
  SHIFTBOSS_OPEN=$OPEN SHIFTBOSS_SUPERVISED=1 bun server/index.ts >> data/server.log 2>&1
  code=$?
  OPEN=0
  # 75: it updated itself and wants the new version running now.
  if [ "$code" = 75 ]; then echo "$(date -u +%FT%TZ) restarting into the new version" >> data/server.log; sleep 1; continue; fi
  # Someone else took the port while we were down: stop looping.
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"; then exit 0; fi
  echo "$(date -u +%FT%TZ) ShiftBoss exited with ${code}; restarting in 3 s" >> data/server.log
  sleep 3
done
