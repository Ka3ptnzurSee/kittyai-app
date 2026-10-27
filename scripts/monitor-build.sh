#!/usr/bin/env bash
# monitor-build.sh – überwacht einen laufenden EAS-iOS-Build und reicht ihn
# nach FINISHED automatisch bei TestFlight ein (pollt alle 60s).
#
# Nutzung:  BUILD_ID=<uuid> bash monitor-build.sh
set -u
BUILD_ID="${BUILD_ID:-}"
APP_DIR="${APP_DIR:-/opt/pi-app/app}"
LOG="$APP_DIR/build-monitor.log"
cd "$APP_DIR" || exit 1

if [ -z "$BUILD_ID" ]; then
  echo "FEHLER: BUILD_ID nicht gesetzt" | tee -a "$LOG"
  exit 1
fi

echo "$(date '+%F %T') START monitor $BUILD_ID" >> "$LOG"

while true; do
  STATUS=$(eas build:list --platform ios --non-interactive --json --limit 20 2>/dev/null | \
    node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const b=j.find(x=>x.id==='$BUILD_ID');console.log(b?b.status:'UNBEKANNT')}catch(e){console.log('PARSE_ERROR')}})")
  echo "$(date '+%F %T') Status: $STATUS" >> "$LOG"
  case "$STATUS" in
    FINISHED)
      echo "$(date '+%F %T') BUILD FERTIG -> submit ..." >> "$LOG"
      eas submit --platform ios --id "$BUILD_ID" --non-interactive >> "$LOG" 2>&1
      echo "$(date '+%F %T') SUBMIT DONE (oder Fehler siehe oben)" >> "$LOG"
      break
      ;;
    ERRORED|CANCELLED)
      echo "$(date '+%F %T') BUILD $STATUS — Abbruch, kein Submit." >> "$LOG"
      break
      ;;
  esac
  sleep 60
done
