// Provisoning-Profile fuer die iOS-Extensions anlegen (App Store, Team VW2SBC8228).
// Laedt die .mobileprovision nach credentials/ und prueft die Entitlements.
//
// Nutzung: node scripts/asc-profiles.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const keys = JSON.parse(fs.readFileSync(path.join(projectDir, 'credentials', 'keys.json'), 'utf8'));
const KEY_PATH = process.env.ASC_KEY_PATH || path.join(projectDir, keys.ascApiKey.keyPath);
const KEY_ID = process.env.ASC_KEY_ID || keys.ascApiKey.keyId;
const ISSUER_ID = process.env.ASC_ISSUER_ID || keys.ascApiKey.issuerId;

const TARGETS = [
  { bundleId: 'com.meister.piapp', name: 'KittyAI' },
  { bundleId: 'com.meister.piapp.share', name: 'KittyAI Share' },
  { bundleId: 'com.meister.piapp.widget', name: 'KittyAI Widget' },
  { bundleId: 'com.meister.piapp.notificationservice', name: 'KittyAI Push Service' },
];

function makeJwt() {
  const key = fs.readFileSync(KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = enc({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }) + '.' + enc({ iss: ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  return data + '.' + crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

const TOKEN = makeJwt();
async function api(method, endpoint, body) {
  const res = await fetch('https://api.appstoreconnect.apple.com' + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = new Error(method + ' ' + endpoint + ' -> ' + res.status);
    e.status = res.status; e.body = json; throw e;
  }
  return json;
}

function decodeProfile(file) {
  // .mobileprovision = CMS(SignedData) um eine XML-Plist herum
  try {
    const der = execFileSync('openssl', ['smime', '-verify', '-noverify', '-inform', 'DER', '-in', file], { encoding: 'utf8' });
    const m = /<key>Entitlements<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(der);
    return { plistOk: true, entitlements: m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 400) : null, bytes: der.length };
  } catch (e) {
    return { plistOk: false, error: String(e.message).slice(0, 120) };
  }
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  // Das Zertifikat MUSS zu credentials/ios_distribution.p12 passen, sonst schlaegt das Signieren fehl.
  // Vergleich ueber die Seriennummer der p12 (fuehrende Nullen ignorieren).
  const p12pw = execFileSync('keysafe', ['show', 'apple/ios-distribution-p12-password'], { encoding: 'utf8' }).trim();
  const p12dir = path.join(projectDir, 'credentials', 'ios_distribution.p12');
  const p12cert = execFileSync('openssl', ['pkcs12', '-in', p12dir, '-nokeys', '-passin', 'pass:' + p12pw], { encoding: 'utf8' });
  const serial = execFileSync('openssl', ['x509', '-noout', '-serial'], { input: p12cert, encoding: 'utf8' }).trim().replace(/^serial=/, '').toUpperCase();
  const norm = (x) => String(x || '').replace(/^0+/, '').toUpperCase();
  const certs = await api('GET', '/v1/certificates?filter[certificateType]=IOS_DISTRIBUTION&limit=50');
  const cert = (certs.data || []).find((c) => norm(c.attributes.serialNumber) === norm(serial));
  if (!cert) throw new Error('kein Zertifikat mit Seriennummer ' + serial + ' (p12 passt zu keinem Account-Zertifikat)');
  console.log('Zertifikat zur p12: ' + cert.id + ' ' + (cert.attributes.name || '') + ' laeuft bis ' + (cert.attributes.expirationDate || '?'));

  const profiles = await api('GET', '/v1/profiles?limit=200');
  const report = [];
  for (const t of TARGETS) {
    const row = { bundleId: t.bundleId, profileId: null, file: null, action: null, error: null };
    try {
      const bundles = await api('GET', '/v1/bundleIds?filter[identifier]=' + encodeURIComponent(t.bundleId) + '&limit=5');
      const bundle = (bundles.data || [])[0];
      if (!bundle) { row.error = 'Bundle-ID fehlt'; report.push(row); continue; }
      const existing = (profiles.data || []).find((p) => p.attributes.name === t.name + ' App Store' || (p.attributes.name || '').startsWith(t.name + ' App Store'));
      let rec = existing;
      if (!rec) {
        if (dry) { row.action = 'wuerde anlegen'; report.push(row); continue; }
        const created = await api('POST', '/v1/profiles', {
          data: {
            type: 'profiles',
            attributes: { name: t.name + ' App Store', profileType: 'IOS_APP_STORE' },
            relationships: {
              bundleId: { data: { type: 'bundleIds', id: bundle.id } },
              certificates: { data: [{ type: 'certificates', id: cert.id }] },
            },
          },
        });
        rec = created.data;
        row.action = 'angelegt';
      } else {
        row.action = 'vorhanden';
      }
      row.profileId = rec.id;
      const content = rec.attributes && rec.attributes.profileContent;
      if (content) {
        const file = path.join(projectDir, 'credentials', 'profile_' + t.bundleId.replace(/\./g, '_') + '.mobileprovision');
        fs.writeFileSync(file, Buffer.from(content, 'base64'), { mode: 0o600 });
        row.file = path.relative(projectDir, file);
        row.check = decodeProfile(file);
      }
    } catch (e) {
      row.error = e.message + (e.body ? ' ' + JSON.stringify(e.body.errors || e.body).slice(0, 300) : '');
    }
    report.push(row);
  }

  const out = path.join(projectDir, 'state', 'asc-profiles.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ ts: new Date().toISOString(), cert: cert.id, report }, null, 2));
  for (const r of report) console.log(JSON.stringify(r));
  console.log('Report: ' + out);
}

main().catch((e) => { console.error('ABBRUCH: ' + e.message); if (e.body) console.error(JSON.stringify(e.body).slice(0, 600)); process.exit(1); });

