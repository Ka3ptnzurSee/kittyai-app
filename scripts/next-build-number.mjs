#!/usr/bin/env node
/**
 * Ermittelt die nächste freie Build-Nummer für die aktuelle App-Version (aus app.json).
 *
 * Quelle der Wahrheit ist Apple App Store Connect: die höchste bereits hochgeladene
 * Build-Nummer dieser Version + 1. Hat die Version noch gar keinen Build (z. B. frisch
 * gebumpte Version), wird die committete buildNumber aus app.json verwendet.
 *
 * Warum nicht `1000 + GITHUB_RUN_NUMBER`: run_number zählt jeden Workflow-Lauf (inkl.
 * Fehlversuche) und produzierte hässliche Sprünge wie 105 -> 1084. Diese Logik knüpft
 * an die echte, bei Apple vorhandene Nummer an — monoton, kollisionsfrei, selbsterklärend.
 *
 * Aufruf:  node scripts/next-build-number.mjs   →  gibt NUR die Zahl auf stdout aus.
 * Fallback (ASC nicht erreichbar): committete buildNumber + Warnung auf stderr.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";

const KEY_ID = process.env.ASC_KEY_ID || "26AXZ5M8UR";
const ISSUER = process.env.ASC_ISSUER_ID || "1a64f714-48a7-43dd-9737-f41c424b20ba";
const KEY_PATH = process.env.ASC_KEY_PATH || "credentials/AscApiKey_26AXZ5M8UR.p8";
const APP_ID = String(process.env.ASC_APP_ID || "6818109107");

// app.json: expo.version (z. B. "0.2.0"), expo.ios.buildNumber (z. B. "106")
const appJson = JSON.parse(fs.readFileSync("app.json", "utf8"));
const version = String(appJson.expo?.version || "");
const committed = parseInt(String(appJson.expo?.ios?.buildNumber), 10) || 1;

let keyPem;
try {
  keyPem = fs.readFileSync(KEY_PATH, "utf8");
} catch (e) {
  // Kein Key (z. B. lokaler Lauf ohne "Restore Apple credentials") → committete Zahl.
  console.error(`ASC-Key '${KEY_PATH}' nicht lesbar (${e.code || e.message}) — nutze committete buildNumber ${committed}`);
  process.stdout.write(String(committed));
  process.exit(0);
}

function b64url(b) {
  return Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function jwt() {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({ iss: ISSUER, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
  const sig = crypto.sign("sha256", Buffer.from(header + "." + claims), { key: keyPem, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(sig)}`;
}
function req(method, path) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        host: "api.appstoreconnect.apple.com",
        path,
        method,
        timeout: 30000,
        headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = d ? JSON.parse(d) : {};
          } catch {
            parsed = { raw: d.slice(0, 300) };
          }
          if (res.statusCode >= 400) reject(new Error(`${method} ${path} -> ${res.statusCode} ${JSON.stringify(parsed).slice(0, 300)}`));
          else resolve(parsed);
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error(`${method} ${path} -> Timeout nach 30 s`)));
    r.on("error", reject);
    r.end();
  });
}

try {
  // 1) preReleaseVersion zur aktuellen Version finden.
  const prvs = await req("GET", `/v1/apps/${APP_ID}/preReleaseVersions?limit=100`);
  const prv = (prvs.data || []).find((p) => p.attributes?.version === version);

  if (!prv) {
    // Version hat noch keinen Eintrag in ASC → committete buildNumber ist der Startwert.
    console.error(`Version ${version} hat noch keine preReleaseVersion in ASC — Start bei committeter buildNumber ${committed}`);
    process.stdout.write(String(committed));
    process.exit(0);
  }

  // 2) Alle Builds dieser Version holen und höchste Nummer bestimmen.
  const builds = await req("GET", `/v1/preReleaseVersions/${prv.id}/builds?limit=200&fields[builds]=version`);
  const nums = (builds.data || [])
    .map((b) => parseInt(b.attributes?.version, 10))
    .filter((n) => !Number.isNaN(n));

  const next = nums.length ? Math.max(...nums) + 1 : committed;
  console.error(`ASC: ${nums.length} Builds für ${version}, max ${nums.length ? Math.max(...nums) : "-"} → nächste ${next}`);
  process.stdout.write(String(next));
} catch (e) {
  // ASC nicht erreichbar → committete buildNumber (kein harter Abbruch des CI-Laufs).
  console.error(`ASC-Abfrage fehlgeschlagen (${e.message}) — nutze committete buildNumber ${committed}`);
  process.stdout.write(String(committed));
}
