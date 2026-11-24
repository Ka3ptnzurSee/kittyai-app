const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 2100 } });
  const fehler = [];
  p.on("pageerror", (e) => fehler.push(String(e).split("\n")[0]));
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(900);
  const txt = async () => (await p.locator("body").innerText()).replace(/\s+/g, " ");
  const schnipsel = (t, marke) => { const i = t.indexOf(marke); return i < 0 ? "(nicht da)" : t.slice(i, i + 90); };
  const vor = await txt();
  // Zins-Slider (Bereich 2) auf Maximum ziehen
  const zins = p.locator('[aria-label^="Zins"]').first();
  const box = await zins.boundingBox();
  await p.mouse.move(box.x + box.width * 0.05, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  const nach = await txt();
  console.log("ZINS vor :", await zins.getAttribute("aria-valuenow"), "→", schnipsel(vor, "ENDKAPITAL"));
  console.log("ZINS nach:", await zins.getAttribute("aria-valuenow"), "→", schnipsel(nach, "ENDKAPITAL"));
  console.log("KPI reagiert:", schnipsel(vor, "ENDKAPITAL") !== schnipsel(nach, "ENDKAPITAL") ? "JA" : "NEIN");
  // Isolation: Bier-Kacheln (Bereich 1) duerfen sich NICHT aendern
  console.log("Bereich-1 isoliert:", schnipsel(vor, "BIER/WOCHE") === schnipsel(nach, "BIER/WOCHE") ? "JA" : "NEIN");
  console.log("FEHLER:", fehler.length ? fehler.join(" | ") : "keine");
  await p.screenshot({ path: "zins.png", fullPage: true });
  await b.close();
})();
