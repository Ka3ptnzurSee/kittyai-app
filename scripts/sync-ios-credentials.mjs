// credentials.json fuer EAS-Local-Builds mit App-Extensions synchronisieren.
//
// EAS erwartet bei mehreren Targets:
//   { "ios": { "<bundleIdentifier>": { provisioningProfilePath, distributionCertificate } } }
// (credentialsJson/types.d.ts: CredentialsJsonIosCredentials = Record<string, ...>)
//
// Quelle: app.json (Haupt-Bundle-ID) + targets/*/expo-target.config.json (Extensions)
//         + die von scripts/asc-profiles.mjs geladenen credentials/profile_*.mobileprovision
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const credPath = path.join(projectDir, 'credentials.json');
const appJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'app.json'), 'utf8'));
const mainBundleId = appJson.expo.ios.bundleIdentifier;

const prev = fs.existsSync(credPath) ? JSON.parse(fs.readFileSync(credPath, 'utf8')) : { ios: {} };
const prevIos = prev.ios || {};
const prevTarget = prevIos.provisioningProfilePath ? prevIos : (prevIos[mainBundleId] || {});
const distCert = prevTarget.distributionCertificate;
if (!distCert || !distCert.path || !distCert.password) {
  throw new Error('credentials.json enthaelt kein distributionCertificate (path+password) - bitte einmal setzen');
}

const targets = [{ bundleId: mainBundleId, profile: prevTarget.provisioningProfilePath }];
const targetsDir = path.join(projectDir, 'targets');
for (const dir of fs.existsSync(targetsDir) ? fs.readdirSync(targetsDir) : []) {
  const cfgPath = path.join(targetsDir, dir, 'expo-target.config.json');
  if (!fs.existsSync(cfgPath)) continue;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.bundleIdentifier) continue;
  const bundleId = cfg.bundleIdentifier.startsWith('.') ? mainBundleId + cfg.bundleIdentifier : cfg.bundleIdentifier;
  const guess = path.join('credentials', 'profile_' + bundleId.replace(/\./g, '_') + '.mobileprovision');
  targets.push({ bundleId, profile: fs.existsSync(path.join(projectDir, guess)) ? guess : null });
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
  ios[t.bundleId] = { provisioningProfilePath: t.profile, distributionCertificate: distCert };
}

fs.writeFileSync(credPath, JSON.stringify({ ...prev, ios }, null, 2) + '\n');
console.log('credentials.json: ' + Object.keys(ios).length + ' Targets');
for (const [id, v] of Object.entries(ios)) console.log('  ' + id + ' -> ' + v.provisioningProfilePath);

