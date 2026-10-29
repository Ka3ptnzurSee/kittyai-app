// asc-distribute-build.mjs — verteilt einen VALIDEN ASC-Build an die externe
// Beta-Gruppe (Public Link) und reicht ihn zur Beta App Review ein.
// Das war historisch der fehlende Schritt: `eas submit` lädt nur hoch,
// verteilt aber NICHT an eine Beta-Gruppe → Build bleibt unsichtbar in TestFlight.
//
// Nutzung:  node scripts/asc-distribute-build.mjs <ascBuildId|buildVersion>
// Exit-Codes: 0 = verteilt (Review optional), 1 = harter Fehler (Auth/Netz/Gruppe),
//             2 = Build noch nicht VALID (retrybar — Polling-Fall)
import fs from "node:fs";
import crypto from "node:crypto";

const APP_ID = process.env.ASC_APP_ID || "6818109107";
const EXT_GROUP_ID = process.env.ASC_EXT_GROUP_ID || "7a74c939-7521-4e6b-83f9-e270f32bc2af";
const KEY_PATH = process.env.ASC_KEY_PATH || "credentials/AscApiKey_26AXZ5M8UR.p8";
const KEY_ID = process.env.ASC_KEY_ID || "26AXZ5M8UR";
const ISSUER_ID = process.env.ASC_ISSUER_ID || "1a64f714-48a7-43dd-9737-f41c424b20ba";
const FETCH_TIMEOUT_MS = 30_000;

const arg = process.argv[2];
if (!arg) {
  console.error("FEHLER: ascBuildId oder buildVersion als Argument nötig.");
  process.exit(1);
}
// Control-Chars/ANSI aus allen Log-Ausgaben entfernen (gegen Log-Injection)
const sanitize = (v) => String(v).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "");
const safeArg = sanitize(arg);

let key;
try {
  key = fs.readFileSync(KEY_PATH, "utf8");
} catch (e) {
  console.error(`FEHLER: API-Key nicht lesbar unter ${KEY_PATH}: ${e.message}`);
  process.exit(1);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: "ES256", kid: KEY_ID, typ: "JWT" };
  const p = { iss: ISSUER_ID, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" };
  const si = b64(h) + "." + b64(p);
  return si + "." + crypto.sign("sha256", Buffer.from(si), { key, format: "pem", type: "pkcs8", dsaEncoding: "ieee-p1363" }).toString("base64url");
}
const H = (() => {
  try {
    return { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" };
  } catch (e) {
    console.error("FEHLER: JWT-Erzeugung fehlgeschlagen: " + sanitize(e.message));
    process.exit(1);
  }
})();
async function api(p, opts = {}) {
  try {
    const r = await fetch("https://api.appstoreconnect.apple.com/v1" + p, {
      ...opts,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { ...H, ...(opts.headers || {}) },
    });
    const txt = await r.text();
    let body = null;
    try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
    return { status: r.status, body };
  } catch (e) {
    return { status: -1, body: { error: e.message } }; // Transportfehler → transient
  }
}

function die(msg) {
  console.error("FEHLER: " + sanitize(msg));
  process.exit(1);
}

// Transportfehler/Timeouts (status -1), 408/429 und 5xx sind transient → retrybar (Exit 2).
function isTransient(status) { return status < 0 || status === 408 || status === 429 || status >= 500; }

// Build-ID auflösen (entweder direkt UUID oder Version → neuester VALID-Build)
let buildId = arg;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg)) {
  const r = await api(`/builds?filter[app]=${encodeURIComponent(APP_ID)}&limit=30&sort=-uploadedDate`);
  if (isTransient(r.status)) {
    console.error(`Build-Liste transient nicht abrufbar (HTTP ${r.status}) — später erneut.`);
    process.exit(2);
  }
  if (r.status < 200 || r.status >= 300) {
    die(`Build-Liste nicht abrufbar (HTTP ${r.status}): ${JSON.stringify(r.body?.errors?.[0] || r.body).slice(0, 300)}`);
  }
  const b = (r.body?.data || []).find((x) => String(x.attributes.version) === String(arg));
  if (!b) {
    die(`Build-Version ${safeArg} nicht gefunden (zu alt oder falsch).`);
  }
  if (b.attributes.processingState !== "VALID") {
    console.log(`Build ${safeArg} noch nicht VALID (${b.attributes.processingState}) in ASC.`);
    process.exit(2);
  }
  buildId = b.id;
  console.log(`Build ${safeArg} → ASC id=${buildId}`);
}

// Build-ID defensiv als UUID validieren (stammt ggf. aus ASC-Antwort)
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(buildId)) {
  die(`Ungültige Build-ID: ${buildId}`);
}

// EXT_GROUP_ID defensiv als UUID validieren (kommt ggf. aus Env)
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(EXT_GROUP_ID)) {
  die(`Ungültige ASC_EXT_GROUP_ID: ${EXT_GROUP_ID}`);
}

// 1) Build an die externe Beta-Gruppe hängen (idempotent; 204 = ok)
let r = await api(`/betaGroups/${EXT_GROUP_ID}/relationships/builds`, {
  method: "POST",
  body: JSON.stringify({ data: [{ id: buildId, type: "builds" }] }),
});
if (isTransient(r.status)) {
  console.error(`Gruppen-Zuweisung transient fehlgeschlagen (HTTP ${r.status}) — später erneut.`);
  process.exit(2);
}
if (r.status === 409) {
  console.log("Gruppen-Zuweisung → Build bereits in Gruppe (HTTP 409).");
} else if (r.status < 200 || r.status >= 300) {
  die(`Gruppen-Zuweisung fehlgeschlagen (HTTP ${r.status}): ${JSON.stringify(r.body?.errors?.[0] || r.body).slice(0, 300)}`);
} else {
  console.log(`Gruppen-Zuweisung → HTTP ${r.status}`);
}

// 2) Beta App Review anstoßen (nötig für externe Tester/Public Link).
//    Ab hier ist der Build bereits verteilt → Fehler sind nicht fatal (Exit 0).
const bbd = await api(`/builds/${buildId}/buildBetaDetail`);
if (isTransient(bbd.status)) {
  console.log(`⚠️ buildBetaDetail transient nicht abrufbar (HTTP ${bbd.status}) — später erneut.`);
  process.exit(2);
}
if (bbd.status < 200 || bbd.status >= 300) {
  console.log(`⚠️ buildBetaDetail nicht abrufbar (HTTP ${bbd.status}) — Build ist trotzdem intern verteilt.`);
  process.exit(0);
}
const extState = bbd.body?.data?.attributes?.externalBuildState;
console.log(`externalBuildState=${extState}`);
if (extState === "READY_FOR_BETA_SUBMISSION") {
  r = await api("/betaAppReviewSubmissions", {
    method: "POST",
    body: JSON.stringify({ data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { id: buildId, type: "builds" } } } } }),
  });
  if (r.status >= 200 && r.status < 300) {
    console.log(`✅ Beta App Review eingereicht (HTTP ${r.status})`);
  } else if (isTransient(r.status)) {
    console.log(`⚠️ Beta-Review-Submission transient fehlgeschlagen (HTTP ${r.status}) — später erneut.`);
    process.exit(2);
  } else {
    const detail = sanitize(r.body?.errors?.[0]?.detail || JSON.stringify(r.body));
    console.log(`⚠️ Beta-Review-Submission nicht durch (HTTP ${r.status}): ${detail}`);
    console.log(`   → Build ist trotzdem intern (IN_BETA_TESTING) für interne Tester verfügbar.`);
  }
} else if (extState === "IN_BETA_TESTING" || extState === "BETA_APPROVED" || extState === "IN_EXTERNAL_TESTING") {
  console.log("✅ Build ist extern bereits im Beta-Testing (keine neue Review nötig).");
} else {
  console.log("ℹ️ externalBuildState unerwartet — manuell prüfen.");
}
process.exit(0);
