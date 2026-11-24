#!/usr/bin/env bash
# build-and-submit.sh – baut die KittyAI-App und lädt sie nach TestFlight.
# KOMPLETT automatisch: Build starten → warten → submit → fertig.
#
# Nutzung:  bash build-and-submit.sh
# Voraussetzungen: eas-cli global installiert, keys.json vorhanden.

set -u
APP_DIR="${APP_DIR:-/opt/kitty/app}"
cd "$APP_DIR" || { echo "FEHLER: $APP_DIR nicht gefunden"; exit 1; }

echo "=== [1/3] Build starten ==="
BUILD_OUT=$(eas build --platform ios --profile production --non-interactive --no-wait 2>&1)
BUILD_URL=$(echo "$BUILD_OUT" | grep -oE 'https://expo.dev/accounts/[^ ]+' | tail -1)
BUILD_ID=$(echo "$BUILD_URL" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

if [ -z "$BUILD_ID" ]; then
  echo "FEHLER: Keine Build-ID gefunden. Ausgabe:"
  echo "$BUILD_OUT" | tail -20
  exit 1
fi
echo "Build-ID: $BUILD_ID"
echo "URL: $BUILD_URL"

echo ""
echo "=== [2/3] Warte auf Build ==="
while true; do
  STATUS=$(eas build:list --platform ios --non-interactive --json --limit 10 2>/dev/null | \
    node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const b=j.find(x=>x.id==='$BUILD_ID');console.log(b?b.status:'UNBEKANNT')}catch(e){console.log('PARSE_ERROR')}})")
  echo "Status: $STATUS"
  case "$STATUS" in
    FINISHED) break ;;
    ERRORED) echo "BUILD FEHLGESCHLAGEN – Logs: $BUILD_URL"; exit 1 ;;
  esac
  sleep 60
done

echo ""
echo "=== [3/3] Nach TestFlight einreichen ==="
eas submit --platform ios --id "$BUILD_ID" --non-interactive

echo ""
echo "=== FERTIG ==="
echo "Build $BUILD_ID ist hochgeladen und wird von Apple verarbeitet."
echo "TestFlight: https://appstoreconnect.apple.com/apps/6818109107/testflight/ios"
echo "(Apple braucht danach noch ~5-10 Min zum Verarbeiten – Nutzer bekommt eine E-Mail.)"
