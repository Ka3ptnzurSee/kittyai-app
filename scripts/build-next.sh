#!/usr/bin/env bash
# build-next.sh — nächster iOS-Build in EINEM Lauf:
#   [1/2] Build-Nummer aus ASC (max+1) holen, app.json bumpen, `eas build --no-wait`
#   [2/2] an build-and-distribute.sh übergeben (Monitor → submit → Verteilung → Review)
#
# Warum: build-and-distribute.sh allein braucht BUILD_ID + BUILD_VER als env und
# baut nicht selbst. Dieses Skript ist der fehlende [1/2]-Schritt.
#
# Nutzung:  nohup bash scripts/build-next.sh > build-distribute-$(date +%Y%m%d-%H%M).log 2>&1 &
#           (Log-Datei vorher mit 600 anlegen — das Skript kann die Rechte des
#            Aufrufer-Redirects nicht mehr ändern.)
set -uo pipefail
umask 077                    # app.json.tmp, Lock, Temp-Dateien nicht world-readable
export HOME=/root            # eas/git-Credentials liegen unter /root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

APP_DIR="${APP_DIR:-/opt/pi-app/app}"
APP_DIR=$(realpath -e -- "$APP_DIR" 2>/dev/null) || { echo "FEHLER: APP_DIR existiert nicht."; exit 1; }
cd "$APP_DIR" || { echo "FEHLER: $APP_DIR nicht wechselbar"; exit 1; }

# Repo darf nicht von nicht-root beschreibbar sein — sonst führen wir als root
# fremden Code aus (scripts/*.mjs, scripts/*.sh).
DIR_MODE=$(stat -c '%a' .)
if [ $(( 0$DIR_MODE & 022 )) -ne 0 ]; then
  echo "FEHLER: $APP_DIR ist gruppen-/welt-schreibbar (mode $DIR_MODE) — fremder Code würde als root laufen. Abbruch."
  exit 1
fi
DIR_UID=$(stat -c '%u' .)
[ "$DIR_UID" -ne 0 ] && echo "HINWEIS: $APP_DIR gehört uid $DIR_UID (nicht root), Rechte $DIR_MODE — nur Schreibrechte zählen hier."

# Kein Doppellauf: zwei Prozesse würden zweimal bumpen und zwei Builds starten.
# Lock in /run (root-eigen, nicht welt-schreibbar) statt /tmp — sonst Symlink-Angriff.
LOCK_DIR=/run/build-next
if [ -L "$LOCK_DIR" ] || { [ -e "$LOCK_DIR" ] && [ ! -d "$LOCK_DIR" ]; }; then
  echo "FEHLER: $LOCK_DIR ist ein Symlink/Fremdtyp — Abbruch."; exit 1
fi
install -d -m 700 -o root -g root "$LOCK_DIR" 2>/dev/null || { echo "FEHLER: $LOCK_DIR nicht anlegbar"; exit 1; }
if [ -L "$LOCK_DIR/lock" ]; then echo "FEHLER: $LOCK_DIR/lock ist ein Symlink — Abbruch."; exit 1; fi
exec 9>>"$LOCK_DIR/lock" || { echo "FEHLER: Lock nicht öffenbar"; exit 1; }
if ! flock -n 9; then
  echo "FEHLER: build-next.sh läuft bereits (Lock $LOCK_DIR/lock belegt)."
  exit 1
fi

# Preflight — fehlendes Werkzeug soll als solches gemeldet werden, nicht als "keine Build-ID".
for bin in eas node flock stat realpath; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "FEHLER: '$bin' nicht gefunden (rc=127) — PATH prüfen."
    exit 1
  fi
done
if [ ! -f scripts/next-build-number.mjs ] || [ ! -f scripts/build-and-distribute.sh ]; then
  echo "FEHLER: scripts/next-build-number.mjs oder scripts/build-and-distribute.sh fehlt."
  exit 1
fi

TMPDIR_BN=$(mktemp -d) || { echo "FEHLER: mktemp fehlgeschlagen"; exit 1; }
cleanup() { rm -rf "$TMPDIR_BN" 2>/dev/null; }
trap cleanup EXIT

# Fremdausgabe entschärfen: Steuerzeichen (ANSI/CR-Injection) raus, Token-Muster redigieren.
san() { tr -d '\000-\010\013-\037\177' 2>/dev/null | sed -E 's/(EXPO_TOKEN|token|password|secret|passcode)[=:][^[:space:]]*/\1=<redacted>/Ig'; }

echo "=== [1/2] EAS-Build starten ($(date '+%F %T')) ==="

# --- Build-Nummer: ASC ist Wahrheit (höchste vorhandene + 1) ---
VER=$(node scripts/next-build-number.mjs 2>"$TMPDIR_BN/err.ver" | tail -1)
VER_ERR=$(cat "$TMPDIR_BN/err.ver" 2>/dev/null || true)
[ -n "$VER_ERR" ] && printf '%s\n' "$VER_ERR" | san
case "$VER" in
  ''|*[!0-9]*) echo "FEHLER: nächste Build-Nummer nicht ermittelbar ('$VER')."; exit 1 ;;
esac
[ "${#VER}" -le 10 ] || { echo "FEHLER: Build-Nummer unplausibel lang (${#VER} Stellen)."; exit 1; }
# Fallback-Pfad des .mjs = committete Nummer OHNE +1 → würde bei Apple kollidieren.
if printf '%s' "$VER_ERR" | grep -qiE 'nutze committete buildNumber|Start bei committeter buildNumber'; then
  echo "FEHLER: ASC-Abfrage fehlgeschlagen — Nummer $VER ist unbestätigt (Kollisionsgefahr). Abbruch."
  exit 1
fi
echo "Build-Version: $VER (aus ASC)"

# --- app.json bumpen (appVersionSource=local → sonst Duplikat bei Apple) ---
cp app.json "$TMPDIR_BN/app.json.prev" || { echo "FEHLER: app.json nicht sicherbar"; exit 1; }
rollback() { cp "$TMPDIR_BN/app.json.prev" app.json 2>/dev/null && echo "app.json zurückgesetzt ($*)"; }
# Einziger Rollback-Fall ist ein FEHLGESCHLAGENER Build-Start: nur dann ist die
# Nummer unverbraucht. Nach erfolgreichem `eas build` bleibt sie stehen (sie ist
# real vergeben) — Zurückdrehen würde eine Kollision erzeugen.
if ! node - "$VER" <<'NODE'
const fs = require("fs");
const path = require("path");
const ver = process.argv[2];
const file = "app.json";
const src = fs.readFileSync(file, "utf8");
const re = /("buildNumber"\s*:\s*")[^"]*(")/;
if (!re.test(src)) { console.error("FEHLER: kein buildNumber in app.json"); process.exit(1); }
const out = src.replace(re, (_m, a, b) => a + ver + b);
try { JSON.parse(out); } catch (e) { console.error("FEHLER: app.json würde ungültig: " + e.message); process.exit(1); }
// O_EXCL: kein Folgen eines präparierten Symlinks auf eine Fremddatei
const tmp = path.join(path.dirname(file), `.app.json.${process.pid}.tmp`);
const fd = fs.openSync(tmp, "wx", 0o644);
try {
  fs.writeFileSync(fd, out);
  fs.fsyncSync(fd);
} finally { fs.closeSync(fd); }
fs.renameSync(tmp, file);
NODE
then
  echo "FEHLER: app.json buildNumber nicht setzbar."
  exit 1
fi
echo "app.json buildNumber → $(node -p 'require("./app.json").expo.ios.buildNumber')"

# --- Build starten (rc wird geprüft; --json statt fragiler URL-Regex) ---
BUILD_JSON=$(eas build --platform ios --profile production --non-interactive --no-wait --json 2>"$TMPDIR_BN/err.build")
EAS_RC=$?
if [ "$EAS_RC" -ne 0 ]; then
  echo "FEHLER: 'eas build' fehlgeschlagen (rc=$EAS_RC)."
  sed -n '1,20p' "$TMPDIR_BN/err.build" 2>/dev/null | san
  printf '%s\n' "$BUILD_JSON" | tail -20 | san
  rollback "eas build rc=$EAS_RC"
  exit 1
fi
# stderr nur gekürzt loggen (eas-Ausgabe kann lange Warnblöcke enthalten)
sed -n '1,10p' "$TMPDIR_BN/err.build" 2>/dev/null | san

BUILD_ID=$(printf '%s' "$BUILD_JSON" | node -e '
let d = "";
process.stdin.on("data", c => (d += c));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(d);
    const b = Array.isArray(j) ? j[0] : j;
    const id = b && (b.id || b.buildId);
    if (typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) console.log(id);
  } catch (e) { /* unten Fallback */ }
});')
# Fallback: UUID aus der Ausgabe ziehen (Steuerzeichen vorher entfernen)
if [ -z "$BUILD_ID" ]; then
  BUILD_ID=$(printf '%s\n' "$BUILD_JSON" | tr -d '\000-\010\013-\037\177' \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
fi

if [ -z "$BUILD_ID" ]; then
  echo "FEHLER: Keine Build-ID ermittelbar — der Build läuft trotzdem (Nummer $VER in Expo prüfen)."
  printf '%s\n' "$BUILD_JSON" | tail -20 | san
  exit 1
fi
echo "Build-ID: $BUILD_ID"
echo "URL: https://expo.dev/accounts/per_h/projects/pi-app/builds/$BUILD_ID"

echo ""
echo "=== [2/2] Monitor + Submit + Verteilung ==="
BUILD_ID="$BUILD_ID" BUILD_VER="$VER" bash scripts/build-and-distribute.sh
rc=$?
echo "=== build-next.sh beendet mit rc=$rc ($(date '+%F %T')) ==="
exit "$rc"
