// credentials.json fuer EAS-Local-Builds mit App-Extensions synchronisieren.
//
// Format bei mehreren Xcode-Targets (eas-cli: credentialsJson/utils.js -> ensureAllTargetsAreConfigured):
//   { "ios": { "<TargetName>": { provisioningProfilePath, distributionCertificate } } }
// Der Schluessel ist der XCODE-TARGETNAME (nicht die Bundle-ID) - der Haupt-Target heisst
// wie app.json expo.name ohne Sonderzeichen, Extension-Targets wie targets/<dir> name/Verzeichnis.
//
// Quelle: app.json (Haupt-Bundle-ID + Name) + targets/*/expo-target.config.json
//         + die von scripts/asc-profiles.mjs geladenen credentials/profile_*.mobileprovision
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const credPath = path.join(projectDir, 'credentials.json');
const appJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'app.json'), 'utf8'));
const mainBundleId = appJson.expo.ios.bundleIdentifier;
const sanitize = (s) => String(s).replace(/[^A-Za-z0-9]/g, '');
const mainTargetName = sanitize(appJson.expo.name || 'App');

const prev = fs.existsSync(credPath) ? JSON.parse(fs.readFileSync(credPath, 'utf8')) : { ios: {} };
const prevIos = prev.ios || {};
const prevTarget = prevIos.provisioningProfilePath
  ? prevIos
  : prevIos[mainTargetName] || Object.values(prevIos)[0] || {};
const distCert = prevTarget.distributionCertificate;
if (!distCert || !distCert.path || !distCert.password) {
  throw new Error('credentials.json enthaelt kein distributionCertificate (path+password) - bitte einmal setzen');
}

const targets = [{ targetName: mainTargetName, bundleId: mainBundleId, profile: prevTarget.provisioningProfilePath }];
const targetsDir = path.join(projectDir, 'targets');
for (const dir of fs.existsSync(targetsDir) ? fs.readdirSync(targetsDir) : []) {
  const cfgPath = path.join(targetsDir, dir, 'expo-target.config.json');
  if (!fs.existsSync(cfgPath)) continue;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.bundleIdentifier) continue;
  const bundleId = cfg.bundleIdentifier.startsWith('.') ? mainBundleId + cfg.bundleIdentifier : cfg.bundleIdentifier;
  const profile = path.join('credentials', 'profile_' + bundleId.replace(/\./g, '_') + '.mobileprovision');
  targets.push({
    targetName: sanitize(cfg.name || dir),
    bundleId,
    profile: fs.existsSync(path.join(projectDir, profile)) ? profile : null,
  });
}

const ios = {};
for (const t of targets) {
  if (!t.profile) {
    console.warn('kein Profil fuer ' + t.bundleId + ' (node scripts/asc-profiles.mjs laufen lassen)');
    continue;
  }
  if (!fs.existsSync(path.join(projectDir, t.profile))) {
    console.warn('Profildatei fehlt: ' + t.profile);
    continue;
  }
  ios[t.targetName] = {
    provisioningProfilePath: t.profile,
    distributionCertificate: distCert,
    // Nur zur Dokumentation, EAS ignoriert unbekannte Felder nicht -> daher auskommentiert:
    // bundleIdentifier: t.bundleId,
  };
}

fs.writeFileSync(credPath, JSON.stringify({ ...prev, ios }, null, 2) + '\n');
console.log('credentials.json: ' + Object.keys(ios).length + ' Targets');
for (const [name, v] of Object.entries(ios)) console.log('  ' + name + ' -> ' + v.provisioningProfilePath);

