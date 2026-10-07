# Apple-Automatisierung – wiederverwendbar

Alles, was für den Apple/App-Store-Workflow nötig ist, liegt **gespeichert und wiederverwendbar** in diesem Repo vor.

## 🔑 Gespeicherte Keys (in `credentials/` – gitignored, nur lokal)

| Zweck | Datei | ID |
|---|---|---|
| App Store Connect API-Key | `credentials/AscApiKey_26AXZ5M8UR.p8` | `26AXZ5M8UR` |
| APNs Push-Key | `credentials/AuthKey_M89Z943C94.p8` | `M89Z943C94` |
| In-App-Purchase/Subscriptions | `credentials/SubscriptionKey_YBQ5Z28K76.p8` | `YBQ5Z28K76` |
| Signier-Zertifikat (.p12) | `credentials/ios_distribution.p12` | – |
| Provisioning-Profil | `credentials/ios_appstore.mobileprovision` | – |
| **Alle Metadaten** | `credentials/keys.json` | Apple-ID, Team-ID, Issuer-ID, Shared Secret … |

> Wichtig: `credentials/` ist in `.gitignore` → die Keys werden **nie** mit Git hochgeladen.

## 🤖 Skripte (in `scripts/`, committet)

| Skript | Was es macht | Aufruf |
|---|---|---|
| `provision-ios.mjs` | Bundle-ID + Zertifikat + Profil für eine (neue) App erzeugen | `node scripts/provision-ios.mjs` |
| `push-key.mjs` | APNs-Push-Key zu EAS hochladen + App zuweisen | `node scripts/push-key.mjs` |

Beide lesen die Zugangsdaten automatisch aus `credentials/keys.json`.

## 🆕 Neue App anlegen (kompletter Ablauf)

```bash
# 1) Provisionierung (Bundle-ID, Zertifikat, Profil)
BUNDLE_ID=com.meister.neueapp APP_NAME="Neue App" node scripts/provision-ios.mjs

# 2) In app.json BUNDLE_ID + Name eintragen, dann bauen
eas build --platform ios --profile production --non-interactive

# 3) Einmalig von Hand (Apple blockiert das per API):
#    https://appstoreconnect.apple.com/apps → "+" → New App
#    (Bundle-ID auswählen, Name, SKU, Language)

# 4) ascAppId in eas.json setzen (per API ermitteln):
#    GET https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=...

# 5) Einreichen
eas submit --platform ios --non-interactive

# 6) Push aktivieren (optional)
node scripts/push-key.mjs
```

## 📌 Wichtigste Werte (Kurzreferenz)

- Apple-ID: `karsdorf.2004@web.de`
- Team-ID: `VW2SBC8228`
- Issuer-ID: `1a64f714-48a7-43dd-9737-f41c424b20ba`
- ASC App-ID (KittyAI): `6818109107`
- Bundle-ID: `com.meister.piapp`

## 🔒 Was Apple NICHT per API erlaubt

1. **App-Record anlegen** (App Store Connect → New App) → muss 1× im Browser passieren.
2. **Individual-Keys** für Provisioning → es muss ein **Team-Key** (mit Issuer-ID) sein.
