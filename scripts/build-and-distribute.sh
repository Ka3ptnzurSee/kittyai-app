#!/usr/bin/env bash
# build-and-distribute.sh — EAS-iOS-Build überwachen, bei FINISHED an TestFlight
# submiten UND an die externe Beta-Gruppe verteilen + Beta-Review einreichen.
# Historisch fehlte genau der Distribute-Schritt → Build blieb unsichtbar.
#
# Nutzung:  BUILD_ID=<uuid> BUILD_VER=<n> bash scripts/build-and-distribute.sh
set -uo pipefail
BUILD_ID="${BUILD_ID:-}"
BUILD_VER="${BUILD_VER:-}"
APP_DIR="${APP_DIR:-/opt/pi-app/app}"
LOG="$APP_DIR/build-distribute.log"
cd "$APP_DIR" || exit 1

if [ -z "$BUILD_ID" ]; then echo "FEHLER: BUILD_ID nicht gesetzt"; exit 1; fi
if [ -z "$BUILD_VER" ]; then echo "FEHLER: BUILD_VER nicht gesetzt"; exit 1; fi

# Eingaben streng validieren (gegen Log-Injection / unerwartete Werte)
case "$BUILD_ID" in
  [0-9a-fA-F][0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*[0-9a-fA-F]*) : ;;
  *) echo "FEHLER: BUILD_ID sieht nicht nach UUID aus"; exit 1 ;;
esac
case "$BUILD_VER" in
  ''|*[!0-9]*) echo "FEHLER: BUILD_VER muss numerisch sein"; exit 1 ;;
esac

# Control-Chars aus Log-Zeilen entfernen (keine Log-Fälschung via \n/\r)
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tr -d '\r' | tee -a "$LOG"; }

log "START monitor build=$BUILD_ID ver=$BUILD_VER"

# 1) Poll bis FINISHED (mit Watchdog: max 90 min, max 10 Parse-Fehler in Folge)
attempt=0
parse_fails=0
while [ "$attempt" -lt 90 ]; do
  # BUILD_ID via env an node übergeben (keine Shell-/JS-Injection durch Interpolation)
  STATUS=$(eas build:list --platform ios --non-interactive --json --limit 20 2>/dev/null \
    | BUILD_ID="$BUILD_ID" node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const b=j.find(x=>x.id===process.env.BUILD_ID);console.log(b?b.status:'UNBEKANNT')}catch(e){console.log('PARSE_ERROR')}})")
  case "$STATUS" in
    FINISHED) log "BUILD FERTIG → submit …"; break ;;
    ERRORED|CANCELLED) log "BUILD $STATUS — Abbruch."; exit 1 ;;
    PARSE_ERROR|UNBEKANNT|"") parse_fails=$((parse_fails + 1)); log "Status nicht lesbar ($STATUS) — Fehler $parse_fails/10."; [ "$parse_fails" -ge 10 ] && { log "Zu viele Parse-Fehler — Abbruch."; exit 1; } ;;
    *) parse_fails=0; log "Status: $STATUS (warte 60s)" ;;
  esac
  attempt=$((attempt + 1))
  sleep 60
done
if [ "$attempt" -ge 90 ]; then log "Watchdog: 90 min ohne FINISHED — Abbruch."; exit 1; fi

# 2) Submit mit Retry (EAS-Queue hängt oft); Erfolg wird festgehalten
submitted=0
for i in $(seq 1 8); do
  log "Submit-Versuch $i/8 …"
  if timeout 300 eas submit --platform ios --id "$BUILD_ID" --non-interactive >> "$LOG" 2>&1; then
    log "Submit exit 0."
    submitted=1
    break
  fi
  log "Submit nicht durch (Queue/Timeout) — warte 60s."
  sleep 60
done
if [ "$submitted" -eq 0 ]; then log "Submit endgültig fehlgeschlagen."; exit 1; fi

# 3) Warten bis Build VALID ist, dann verteilen + Review.
#    Exit-Codes vom mjs: 0 = verteilt, 1 = harter Fehler, 2 = noch nicht VALID (retry)
for i in $(seq 1 60); do
  sleep 30
  node scripts/asc-distribute-build.mjs "$BUILD_VER" >> "$LOG" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then log "✅ Verteilung + Review abgeschlossen."; exit 0; fi
  if [ "$rc" -eq 2 ]; then log "Build noch nicht VALID — Versuch $i/60."; continue; fi
  log "Verteilung fehlgeschlagen (rc=$rc) — Abbruch."; exit 1
done
log "Timeout beim Verteilen — manuell prüfen."
exit 1
