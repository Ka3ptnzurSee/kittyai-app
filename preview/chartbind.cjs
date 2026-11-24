const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 1600 } });
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(900);
  // Chart-Bereich = Vorfahre des Labels "x1"; darin Balkenhoehen (divs mit Akzentfarbe)
  const balken = async () => p.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent.trim() === "x1");
    if (!el) return null;
    let box = el.parentElement;
    for (let i = 0; i < 4 && box && box.parentElement; i++) box = box.parentElement;
    const rech = [...box.querySelectorAll("div")].map((d) => d.getBoundingClientRect())
      .filter((r) => r.height > 2 && r.height < 300 && r.width > 3 && r.width < 120)
      .map((r) => Math.round(r.height));
    return { boxHoehe: Math.round(box.getBoundingClientRect().height), hoehen: rech.slice(0, 8), text: box.innerText.replace(/\s+/g, " ").slice(0, 80) };
  });
  const vor = await balken();
  const slider = p.locator('[aria-label^="Menge (App-Pfad)"]').first();
  const box = await slider.boundingBox();
  await p.mouse.move(box.x + box.width * 0.05, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  const nach = await balken();
  console.log("VOR :", JSON.stringify(vor));
  console.log("NACH:", JSON.stringify(nach));
  console.log("CHART REAGIERT:", JSON.stringify(vor) !== JSON.stringify(nach) ? "JA" : "NEIN");
  await b.close();
})();
