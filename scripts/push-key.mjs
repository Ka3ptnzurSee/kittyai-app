// Lädt einen APNs-Push-Key zu EAS/Expo hoch und weist ihn der App zu.
// Wiederverwendbar: einfach mit den Werten aus credentials/keys.json aufrufen.
//
// Nutzung:
//   node scripts/push-key.mjs <apnsKeyPath> <apnsKeyId>
//
// Voraussetzungen:
//   - In EAS eingeloggt (Session in ~/.expo/state.json)
//   - App existiert als EAS-Projekt (projectId in app.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');

function loadState() {
  return JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || '~', '.expo', 'state.json'), 'utf8'));
}
function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function gql(sessionSecret, query, variables) {
  const res = await fetch('https://api.expo.dev/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'expo-session': sessionSecret },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors, null, 2).slice(0, 900));
  return j.data;
}

async function main() {
  const [keyPathArg, keyIdArg] = process.argv.slice(2);
  const keys = loadJson(path.join(projectDir, 'credentials', 'keys.json'));
  const keyPath = keyPathArg || path.join(projectDir, keys.apnsKey.keyPath);
  const keyId = keyIdArg || keys.apnsKey.keyId;
  const keyP8 = fs.readFileSync(keyPath, 'utf8');

  const appJson = loadJson(path.join(projectDir, 'app.json'));
  const owner = appJson.expo.owner;
  const projectId = appJson.expo.extra?.eas?.projectId;
  const slug = appJson.expo.slug;
  const bundleId = appJson.expo.ios?.bundleIdentifier || appJson.expo.android?.package;
  const fullName = `@${owner}/${slug}`;

  const sessionSecret = loadState().auth.sessionSecret;
  console.log(`→ Lade Push-Key ${keyId} zu @${owner}/${slug} hoch …`);

  // 1) Account + Team
  const q1 = `query($accountName: String!) {
    account { byName(accountName: $accountName) {
      id name
      appleTeams { id appleTeamIdentifier }
    } }
  }`;
  const d1 = await gql(sessionSecret, q1, { accountName: owner });
  const account = d1.account.byName;
  const team = account.appleTeams.find(t => t.appleTeamIdentifier === keys.teamId) || account.appleTeams[0];
  if (!team) throw new Error('Kein Apple-Team gefunden');

  // 2) Push-Key anlegen
  const q2 = `mutation($accountId: ID!, $input: ApplePushKeyInput!) {
    applePushKey { createApplePushKey(accountId: $accountId, applePushKeyInput: $input) { id keyIdentifier } }
  }`;
  const d2 = await gql(sessionSecret, q2, {
    accountId: account.id,
    input: { appleTeamId: team.id, keyIdentifier: keyId, keyP8 },
  });
  const pushKeyId = d2.applePushKey.createApplePushKey.id;
  console.log(`✓ Push-Key angelegt (id=${pushKeyId})`);

  // 3) AppleAppIdentifier + IosAppCredentials holen/erstellen
  const q3 = `query($accountName: String!, $bundleIdentifier: String!) {
    account { byName(accountName: $accountName) {
      appleAppIdentifiers(bundleIdentifier: $bundleIdentifier) { id }
    } }
  }`;
  const d3 = await gql(sessionSecret, q3, { accountName: owner, bundleIdentifier: bundleId });
  const ident = d3.account.byName.appleAppIdentifiers[0];
  if (!ident) throw new Error(`Bundle-ID ${bundleId} nicht auf EAS registriert – erst provisionieren`);

  // Bestehende Credentials?
  const q4 = `query($fullName: String!) {
    app { byFullName(fullName: $fullName) { id iosAppCredentials { id appleAppIdentifier { id } } } }
  }`;
  const d4 = await gql(sessionSecret, q4, { fullName });
  const appId = d4.app.byFullName.id;
  let cred = d4.app.byFullName.iosAppCredentials.find(c => c.appleAppIdentifier?.id === ident.id);

  if (cred) {
    // Push-Key zuweisen
    const m = `mutation($id: ID!, $pushKeyId: ID!) {
      iosAppCredentials { setPushKey(id: $id, pushKeyId: $pushKeyId) { id } }
    }`;
    await gql(sessionSecret, m, { id: cred.id, pushKeyId });
    console.log(`✓ Push-Key der App zugewiesen`);
  } else {
    const m = `mutation($input: IosAppCredentialsInput!, $appId: ID!, $appleAppIdentifierId: ID!) {
      iosAppCredentials { createIosAppCredentials(iosAppCredentialsInput: $input, appId: $appId, appleAppIdentifierId: $appleAppIdentifierId) { id } }
    }`;
    await gql(sessionSecret, m, {
      input: { appleTeamId: team.id, pushKeyId },
      appId,
      appleAppIdentifierId: ident.id,
    });
    console.log(`✓ Credentials erstellt + Push-Key zugewiesen`);
  }
  console.log('\nFertig. Push funktioniert jetzt im echten Build.');
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
