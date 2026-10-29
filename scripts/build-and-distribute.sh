#!/usr/bin/env bash
# build-and-distribute.sh — EAS-iOS-Build überwachen, bei FINISHED an TestFlight
# submiten UND an die externe Beta-Gruppe verteilen + Beta-Review einreichen.
# Historisch fehlte genau der Distribute-Schritt → Build blieb unsichtbar.
#
# Nutzung:  BUILD_ID=<uuid> BUILD_VER=<n> bash scripts/build-and-distribute.sh
set -u
BUILD_ID="${BUILD_ID:-}"
BUILD_VER="${BUILD_VER:-}"
APP_DIR="${APP_DIR:-/opt/pi-app/app}"
LOG="$APP_DIR/build-distribute.log"
cd "$APP_DIR" || exit 1

if [ -z "$BUILD_ID" ]; then echo "FEHLER: BUILD_ID nicht gesetzt"; exit 1; fi
if [ -z "$BUILD_VER" ]; then echo "FEHLER: BUILD_VER nicht gesetzt"; exit 1; fi

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

log "START monitor build=$BUILD_ID ver=$BUILD_VER"

# 1) Poll bis FINISHED
while true; do
  STATUS=$(eas build:list --platform ios --non-interactive --json --limit 20 2>/dev/null | \
    node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const b=j.find(x=>x.id==='$BUILD_ID');console.log(b?b.status:'UNBEKANNT')}catch(e){console.log('PARSE_ERROR')}})")
  case "$STATUS" in
    FINISHED) log "BUILD FERTIG → submit …"; break ;;
    ERRORED|CANCELLED) log "BUILD $STATUS — Abbruch."; exit 1 ;;
    *) log "Status: $STATUS (warte 60s)"; sleep 60 ;;
  esac
done

# 2) Submit mit Retry (EAS-Queue hängt oft)
for i in $(seq 1 8); do
  log "Submit-Versuch $i/8 …"
  if timeout 300 eas submit --platform ios --id "$BUILD_ID" --non-interactive >> "$LOG" 2>&1; then
    log "Submit exit 0."
    break
  fi
  log "Submit nicht durch (Queue/Timeout) — warte 60s."
  sleep 60
done

# 3) Warten bis Build VALID in ASC ist, dann verteilen + Review
for i in $(seq 1 60); do
  sleep 30
  OUT=$(node scripts/asc-distribute-build.mjs "$BUILD_VER" 2>&1)
  if echo "$OUT" | grep -qE 'externalBuildState=IN_BETA_TESTING|externalBuildState=BETA_APPROVED|externalBuildState=IN_EXTERNAL_TESTING|Beta App Review eingereicht|HTTP 204'; then
    log "$OUT"
    log "✅ Verteilung + Review angestoßen."
    exit 0
  fi
  if echo "$OUT" | grep -q 'FEHLER: Kein VALID-Build'; then
    log "Build noch nicht VALID (wird verarbeitet) — Versuch $i/60."
  else
    log "$OUT"
  fi
done
log "Timeout beim Verteilen — manuell prüfen."
exit 1
