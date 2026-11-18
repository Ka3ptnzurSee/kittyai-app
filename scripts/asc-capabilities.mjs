// App Store Connect API — Bundle-IDs und Capabilities fuer die iOS-Extensions.
// Bewusst ohne externe Abhaengigkeit (nur node:crypto), damit der Lauf auf jedem Host geht.
//
// Nutzung:
//   node scripts/asc-capabilities.mjs --dry-run          (nur lesen, zeigt Soll/Ist)
//   node scripts/asc-capabilities.mjs --apply            (anlegen, was fehlt)
//
// Env-Override: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, TEAM_ID
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const keys = JSON.parse(fs.readFileSync(path.join(projectDir, 'credentials', 'keys.json'), 'utf8'));

const KEY_PATH = process.env.ASC_KEY_PATH || path.join(projectDir, keys.ascApiKey.keyPath);
const KEY_ID = process.env.ASC_KEY_ID || keys.ascApiKey.keyId;
const ISSUER_ID = process.env.ASC_ISSUER_ID || keys.ascApiKey.issuerId;
const TEAM_ID = process.env.TEAM_ID || keys.teamId;

const ROOT_BUNDLE = 'com.meister.piapp';
const APP_GROUP = 'group.com.meister.piapp';

// Soll-Zustand: welche Bundle-ID braucht welche Capability?
const TARGETS = [
  { bundleId: ROOT_BUNDLE, name: 'KittyAI', capabilities: ['PUSH_NOTIFICATIONS', 'APP_GROUPS'] },
  { bundleId: ROOT_BUNDLE + '.widget', name: 'KittyAI Widget', capabilities: ['APP_GROUPS'] },
  { bundleId: ROOT_BUNDLE + '.share', name: 'KittyAI Share', capabilities: ['APP_GROUPS'] },
  { bundleId: ROOT_BUNDLE + '.notificationservice', name: 'KittyAI Push Service', capabilities: ['PUSH_NOTIFICATIONS', 'APP_GROUPS'] },
];

function makeJwt() {
  const key = fs.readFileSync(KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = enc({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  const payload = enc({ iss: ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  const data = header + '.' + payload;
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return data + '.' + sig.toString('base64url');
}

let TOKEN = null;
async function api(method, endpoint, body) {
  if (!TOKEN) TOKEN = makeJwt();
  const res = await fetch('https://api.appstoreconnect.apple.com' + endpoint, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(method + ' ' + endpoint + ' -> HTTP ' + res.status);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function listAll(endpoint) {
  const out = [];
  let next = endpoint;
  while (next) {
    const page = await api('GET', next);
    out.push(...(page.data || []));
    const n = page.links && page.links.next;
    next = n ? n.replace('https://api.appstoreconnect.apple.com', '') : null;
  }
  return out;
}

async function findBundleId(bundleId) {
  const q = encodeURIComponent(bundleId);
  const page = await api('GET', '/v1/bundleIds?filter[identifier]=' + q + '&limit=10');
  return (page.data || []).find((b) => b.attributes.identifier === bundleId) || null;
}

async function createBundleId(target) {
  const res = await api('POST', '/v1/bundleIds', {
    data: {
      type: 'bundleIds',
      attributes: { identifier: target.bundleId, name: target.name, platform: 'IOS', seedId: TEAM_ID },
    },
  });
  return res.data;
}

async function listCapabilities(id) {
  const page = await api('GET', '/v1/bundleIds/' + id + '/bundleIdCapabilities');
  return (page.data || []).map((c) => c.attributes.capabilityType);
}

async function enableCapability(id, capabilityType) {
  return api('POST', '/v1/bundleIdCapabilities', {
    data: {
      type: 'bundleIdCapabilities',
      // APP_GROUPS nimmt KEINE settings entgegen (nur ICLOUD_VERSION, DATA_PROTECTION_PERMISSION_LEVEL, APPLE_ID_AUTH_APP_CONSENT sind erlaubt) — die Gruppe selbst kennt die ASC-API nicht.
      attributes: { capabilityType },
      relationships: { bundleId: { data: { type: 'bundleIds', id } } },
    },
  });
}

async function probeAppGroups() {
  const probes = [];
  // Nicht oeffentlich dokumentiert — deshalb testen statt raten.
  for (const ep of ['/v1/appGroups?limit=5', '/v1/appGroupIdentifiers?limit=5', '/v1/appGroups']) {
    try {
      const r = await api('GET', ep);
      return { endpoint: ep, ok: true, count: (r.data || []).length, sample: (r.data || [])[0] || null };
    } catch (e) {
      probes.push({ endpoint: ep, status: e.status });
    }
  }
  return { endpoint: null, ok: false, probes };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const report = { ts: new Date().toISOString(), apply, team: TEAM_ID, bundleIds: [], appGroupProbe: null };

  if (!fs.existsSync(KEY_PATH)) throw new Error('ASC-Key fehlt: ' + KEY_PATH);
  if (!fs.readFileSync(KEY_PATH, 'utf8').includes('PRIVATE KEY')) throw new Error('kein .p8: ' + KEY_PATH);

  const all = await listAll('/v1/bundleIds?limit=200');
  const known = new Set(all.map((b) => b.attributes.identifier));

  for (const target of TARGETS) {
    const row = { bundleId: target.bundleId, existed: known.has(target.bundleId), created: false, capsBefore: [], capsEnabled: [], error: null };
    try {
      let rec = await findBundleId(target.bundleId);
      if (!rec && apply) {
        rec = await createBundleId(target);
        row.created = true;
      }
      if (!rec) {
        row.error = 'fehlt (dry-run: nicht angelegt)';
        report.bundleIds.push(row);
        continue;
      }
      row.id = rec.id;
      row.capsBefore = await listCapabilities(rec.id);
      for (const cap of target.capabilities) {
        if (row.capsBefore.includes(cap)) continue;
        if (!apply) { row.capsEnabled.push(cap + ' (dry-run)'); continue; }
        try {
          await enableCapability(rec.id, cap);
          row.capsEnabled.push(cap);
        } catch (e) {
          row.capsEnabled.push(cap + ' FEHLER ' + e.status + ' ' + JSON.stringify(e.body && e.body.errors && e.body.errors[0] && e.body.errors[0].detail));
        }
      }
    } catch (e) {
      row.error = e.message + (e.body ? ' ' + JSON.stringify(e.body.errors || e.body) : '');
    }
    report.bundleIds.push(row);
  }

  report.appGroupProbe = await probeAppGroups();

  const outPath = path.join(projectDir, 'state', 'asc-capabilities.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  for (const r of report.bundleIds) console.log((r.error ? 'FEHLER ' : 'ok     ') + r.bundleId.padEnd(42) + ' ' + JSON.stringify({ existed: r.existed, created: r.created, capsBefore: r.capsBefore, capsEnabled: r.capsEnabled, error: r.error }));
  console.log('App-Group-Endpoint: ' + JSON.stringify(report.appGroupProbe));
  console.log('Report: ' + outPath);
}

main().catch((e) => { console.error('ABBRUCH: ' + e.message); if (e.body) console.error(JSON.stringify(e.body)); process.exit(1); });

