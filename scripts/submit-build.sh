#!/usr/bin/env bash
# submit-build.sh – submitted einen fertigen EAS-Build an TestFlight und
# retried die EAS-Submit-Queue ("waiting for an available submitter") bis sie frei ist.
# Nutzung: BUILD_ID=<uuid> [RETRIES=8] bash submit-build.sh
set -u
BUILD_ID="${BUILD_ID:-}"
RETRIES="${RETRIES:-8}"
cd /opt/kitty/app || exit 1
for i in $(seq 1 "$RETRIES"); do
  echo "[$(date +%H:%M:%S)] Submit-Versuch $i/$RETRIES (build $BUILD_ID)"
  timeout 240 eas submit --platform ios --id "$BUILD_ID" --non-interactive 2>&1 | grep -vE '^⠋|^⠙|^⠹|^⠸|^⠼|^⠴|^⠦|^⠧|^⠇|^⠏|Proceeding with outdated' | tail -n 15
  if [ "${PIPESTATUS[0]}" = "0" ]; then
    echo "[$(date +%H:%M:%S)] Submit abgeschlossen (exit 0)"
    exit 0
  fi
  echo "[$(date +%H:%M:%S)] Submit nicht durch (Queue voll/Timeout) — warte 60s…"
  sleep 60
done
echo "[$(date +%H:%M:%S)] Retries aufgebraucht"
exit 1
