// iOS-Provisionierung über die App Store Connect API (Team-Key).
// Wiederverwendbar fuer beliebige Apps/Bundle-IDs.
//
// Erzeugt: Bundle-ID (falls nötig), Distribution-Zertifikat (.p12),
// App-Store-Provisioning-Profil (.mobileprovision) → schreibt credentials.json.
//
// Nutzung:
//   node scripts/provision-ios.mjs                 (liest credentials/keys.json)
//   BUNDLE_ID=com.example.app APP_NAME="Meine App" node scripts/provision-ios.mjs
//
// Env-Override (optional, sonst aus keys.json):
//   ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, BUNDLE_ID, APP_NAME
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');

// apple-utils aus der globalen eas-cli-Installation laden
function loadAppleUtils() {
  const candidates = [
    'C:/Users/Meister/AppData/Roaming/npm/node_modules/eas-cli/node_modules/@expo/apple-utils',
    path.join(projectDir, 'node_modules/@expo/apple-utils'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* weiter */ }
  }
  throw new Error('@expo/apple-utils nicht gefunden – eas-cli global installieren: npm i -g eas-cli');
}

const {
  Token, BundleId, BundleIdPlatform, Certificate, CertificateType,
  Profile, ProfileType, createCertificateAndP12Async,
} = loadAppleUtils();

function loadKeys() {
  return JSON.parse(fs.readFileSync(path.join(projectDir, 'credentials', 'keys.json'), 'utf8'));
}

const keys = loadKeys();
const BUNDLE_ID = process.env.BUNDLE_ID || keys.appStoreConnect.bundleIdentifier || 'com.meister.piapp';
const APP_NAME = process.env.APP_NAME || keys.appStoreConnect.appName || 'KittyAI';

async function main() {
  const keyPath = process.env.ASC_KEY_PATH || path.join(projectDir, keys.ascApiKey.keyPath);
  const keyId = process.env.ASC_KEY_ID || keys.ascApiKey.keyId;
  const issuerId = process.env.ASC_ISSUER_ID || keys.ascApiKey.issuerId;

  const keyP8 = fs.readFileSync(keyPath, 'utf8');
  if (!keyP8.includes('PRIVATE KEY')) {
    throw new Error(`${keyPath} sieht nicht nach einer .p8-Datei aus`);
  }

  const token = new Token({ key: keyP8, issuerId, keyId, duration: 1200 });
  const context = { token };

  // 1) Bundle-ID anlegen / finden
  let bundleId = await BundleId.findAsync(context, { identifier: BUNDLE_ID });
  if (!bundleId) {
    console.log(`→ Bundle-ID "${BUNDLE_ID}" anlegen …`);
    bundleId = await BundleId.createAsync(context, {
      name: APP_NAME, identifier: BUNDLE_ID, platform: BundleIdPlatform.IOS,
    });
    console.log(`✓ Bundle-ID angelegt (id=${bundleId.id})`);
  } else {
    console.log(`✓ Bundle-ID existiert bereits (id=${bundleId.id})`);
  }

  // 2) Vorhandene Distribution-Zertifikate prüfen (Limit: 3)
  const existingCerts = await Certificate.getAsync(context, {
    query: { filter: { certificateType: [CertificateType.IOS_DISTRIBUTION, CertificateType.DISTRIBUTION] } },
  });
  console.log(`→ ${existingCerts.length} iOS-Distribution-Zertifikat(e) vorhanden`);
  if (existingCerts.length >= 3) {
    console.warn('⚠️  Es sind schon 3 Distribution-Zertifikate vorhanden (Apple-Limit). Alte ggf. widerrufen.');
  }

  // 3) Neues Distribution-Zertifikat + p12
  console.log('→ Distribution-Zertifikat + .p12 erzeugen …');
  const { certificate, certificateP12, password } = await createCertificateAndP12Async(context, {
    certificateType: CertificateType.IOS_DISTRIBUTION,
  });
  console.log(`✓ Zertifikat erstellt (id=${certificate.id}, serial=${certificate.attributes.serialNumber})`);

  // 4) App-Store-Provisioning-Profil
  const profileName = `${APP_NAME} ${BUNDLE_ID} AppStore`;
  console.log(`→ Provisioning-Profil "${profileName}" erzeugen …`);
  const profile = await Profile.createAsync(context, {
    bundleId: bundleId.id,
    certificates: [certificate.id],
    devices: [],
    name: profileName,
    profileType: ProfileType.IOS_APP_STORE,
  });
  console.log(`✓ Profil erstellt (id=${profile.id}, uuid=${profile.attributes.uuid})`);

  // 5) Dateien schreiben
  const credsDir = path.join(projectDir, 'credentials');
  fs.mkdirSync(credsDir, { recursive: true });
  const p12Path = path.join(credsDir, 'ios_distribution.p12');
  const profilePath = path.join(credsDir, 'ios_appstore.mobileprovision');
  fs.writeFileSync(p12Path, Buffer.from(certificateP12, 'base64'));
  fs.writeFileSync(profilePath, Buffer.from(profile.attributes.profileContent, 'base64'));

  fs.writeFileSync(path.join(projectDir, 'credentials.json'), JSON.stringify({
    ios: {
      provisioningProfilePath: 'credentials/ios_appstore.mobileprovision',
      distributionCertificate: { path: 'credentials/ios_distribution.p12', password },
    },
  }, null, 2) + '\n');

  console.log('\n=== Fertig ===');
  console.log('Bundle-ID:', BUNDLE_ID);
  console.log('p12:       credentials/ios_distribution.p12');
  console.log('Profil:    credentials/ios_appstore.mobileprovision');
  console.log('credentials.json geschrieben');
  console.log('\nNächster Schritt:  eas build --platform ios --profile production --non-interactive');
}

main().catch((e) => { console.error('FEHLER:', e?.message ?? e); process.exit(1); });
