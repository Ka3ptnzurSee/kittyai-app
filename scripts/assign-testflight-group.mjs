#!/usr/bin/env node
/**
 * Weist den neuesten verarbeiteten TestFlight-Build der internen Tester-Gruppe zu.
 *
 * Warum: `eas submit` lädt den Build nur hoch. Ohne Zuweisung zu einer Beta-Gruppe
 * erscheint er bei den Testern nicht (in der ASC-UI: "Build in groups: KEINE").
 * Zusätzlich kann der Build noch `processingState: PROCESSING` sein — dann wartet
 * das Skript, bis Apple ihn freigibt.
 *
 * Aufruf:  node scripts/assign-testflight-group.mjs [--app <ascAppId>] [--dry]
 * Default-App: KittyAI (6818109107). Blockphone: 6826450166.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";

const KEY_ID = process.env.ASC_KEY_ID || "26AXZ5M8UR";
const ISSUER = process.env.ASC_ISSUER_ID || "1a64f714-48a7-43dd-9737-f41c424b20ba";
const KEY_PATH = process.env.ASC_KEY_PATH || "credentials/AscApiKey_26AXZ5M8UR.p8";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const appIdx = argv.indexOf("--app");
const APP_ID = String(appIdx >= 0 ? argv[appIdx + 1] : process.env.ASC_APP_ID || "6818109107");
if (!/^\d+$/.test(APP_ID)) {
  console.error(`FEHLER: ungueltige App-ID '${APP_ID}' (nur Ziffern erlaubt)`);
  process.exit(2);
}

let keyPem;
try {
  keyPem = fs.readFileSync(KEY_PATH, "utf8");
} catch (e) {
  console.error(`FEHLER: ASC-Key '${KEY_PATH}' nicht lesbar (${e.code || e.message}) — laeuft 'Restore Apple credentials'?`);
  process.exit(2);
}

function b64url(b) {
  return Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function jwt() {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({ iss: ISSUER, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
  const data = header + "." + claims;
  const sig = crypto.sign("sha256", Buffer.from(data), { key: keyPem, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64url(sig)}`;
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = https.request(
      {
        host: "api.appstoreconnect.apple.com",
        path,
        method,
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${jwt()}`,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = d ? JSON.parse(d) : {};
          } catch {
            parsed = { raw: d.slice(0, 400) };
          }
          if (res.statusCode >= 400) reject(new Error(`${method} ${path} -> ${res.statusCode} ${JSON.stringify(parsed).slice(0, 400)}`));
          else resolve(parsed);
        });
      },
    );
    // Ohne hartes Timeout kann der Job am Runner-Limit (90 min) hängen statt zu scheitern.
    r.on("timeout", () => r.destroy(new Error(`${method} ${path} -> Timeout nach 30 s`)));
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function latestBuild() {
  const r = await req(
    "GET",
    `/v1/builds?filter[app]=${APP_ID}&sort=-uploadedDate&limit=5&fields[builds]=version,processingState,uploadedDate,expired`,
  );
  return (r.data || [])[0] || null;
}

async function main() {
  console.log(`App-ID ${APP_ID}${DRY ? " (dry)" : ""}`);

  let build = null;
  // Apple braucht nach dem Upload typisch 2–10 min; 45 × 20 s = 15 min Deckel.
  for (let i = 0; i < 45; i++) {
    build = await latestBuild();
    if (build && build.attributes.processingState === "VALID") break;
    console.log(`  warte auf Verarbeitung (${build?.attributes.processingState || "kein Build"}) …`);
    await sleep(20000);
  }
  if (!build) throw new Error("kein Build gefunden");
  if (build.attributes.processingState !== "VALID") {
    // Nicht VALID = nicht installierbar. Fehlschlag muss sichtbar sein, nicht still
    // als "zugewiesen" durchlaufen (sonst sieht der Tester den Build nie).
    throw new Error(`Build ${build.attributes.version} ist ${build.attributes.processingState}, nicht VALID — nach 15 min Wartezeit aufgegeben`);
  }
  const ver = build.attributes.version;
  console.log(`  neuester Build: ${ver} — VALID`);

  const groups = await req("GET", `/v1/apps/${APP_ID}/betaGroups?limit=50&fields[betaGroups]=name,isInternalGroup,createdDate`);
  const internal = (groups.data || []).filter((g) => g.attributes.isInternalGroup === true);
  const all = groups.data || [];
  console.log(`  Gruppen: ${all.map((g) => `${g.attributes.name}${g.attributes.isInternalGroup ? " (intern)" : ""}`).join(", ") || "keine"}`);

  const targets = internal.length ? internal : all.slice(0, 1);
  if (!targets.length) throw new Error("keine Beta-Gruppe vorhanden");
  if (DRY) {
    console.log(`  würde ${ver} zuweisen an: ${targets.map((t) => t.attributes.name).join(", ")}`);
    return;
  }

  const failures = [];
  for (const g of targets) {
    try {
      await req("POST", `/v1/betaGroups/${g.id}/relationships/builds`, { data: [{ type: "builds", id: build.id }] });
      console.log(`  ✔ ${ver} → ${g.attributes.name}`);
    } catch (e) {
      // 409/422 = Build hängt schon an dieser Gruppe (Apple liefert keinen eigenen Code
      // dafür, sondern "An app build can only be assigned to a beta group once").
      if (/-> (409|422)/.test(e.message)) {
        console.log(`  = ${ver} war bereits in ${g.attributes.name}`);
        continue;
      }
      console.error(`  ! ${g.attributes.name}: ${e.message.slice(0, 160)}`);
      failures.push(g.attributes.name);
    }
  }
  if (failures.length) throw new Error(`Zuweisung fehlgeschlagen für: ${failures.join(", ")}`);
}

main().catch((e) => {
  console.error(`FEHLER: ${e.message}`);
  process.exit(1);
});
