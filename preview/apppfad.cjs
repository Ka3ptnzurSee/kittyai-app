const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 1400 } });
  const fehler = [];
  p.on("pageerror", (e) => fehler.push(String(e).split("\n")[0]));
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(900);
  const slider = p.locator('[aria-label^="Menge (App-Pfad)"]').first();
  // Balken des App-Pfad-Charts: alle Divs im letzten Chart mit Akzentfarbe und Hoehe>4
  const balken = async () => p.evaluate(() => {
    const alle = [...document.querySelectorAll("div")];
    const rech = alle.map((d) => d.getBoundingClientRect()).filter((r) => r.height > 4 && r.height < 260 && r.width > 10 && r.width < 80);
    return rech.slice(-6).map((r) => Math.round(r.height));
  });
  const vor = await balken();
  const box = await slider.boundingBox();
  await p.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(600);
  const nach = await balken();
  console.log("SLIDER-Wert:", await slider.getAttribute("aria-valuenow"));
  console.log("BALKEN vor:", JSON.stringify(vor));
  console.log("BALKEN nach:", JSON.stringify(nach));
  console.log("BEWEGT:", JSON.stringify(vor) !== JSON.stringify(nach) ? "JA" : "NEIN");
  console.log("FEHLER:", fehler.length ? fehler.join(" | ") : "keine");
  await p.screenshot({ path: "apppfad.png", fullPage: true });
  await b.close();
})();
