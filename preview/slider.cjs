const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 1180 } });
  const fehler = [];
  p.on("pageerror", (e) => fehler.push(String(e).split("\n")[0]));
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(900);
  console.log("MARKEN:", (await p.locator('[aria-label*="setzen"]').allInnerTexts()).join(" / "));
  // Bubble waehrend des Ziehens pruefen
  const box = await p.locator('[aria-label^="Bier pro Woche"]').first().boundingBox();
  await p.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2, { steps: 10 });
  const bubble = await p.locator("body").innerText();
  await p.mouse.up();
  await p.waitForTimeout(300);
  // Marke antippen (Sprung auf 15)
  await p.locator('[aria-label*="auf 15 setzen"]').first().click();
  await p.waitForTimeout(400);
  const jetzt = await p.evaluate(() => document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow"));
  const deaktiviert = await p.evaluate(() => document.querySelectorAll('[aria-disabled="true"]').length);
  console.log("BUBBLE-TEXT waehrend Zug:", bubble.replace(/\n+/g, " ").slice(0, 60));
  console.log("NACH MARKEN-TAP aria-valuenow:", jetzt);
  console.log("DEAKTIVIERTE Slider:", deaktiviert);
  console.log("FEHLER:", fehler.length ? fehler.join(" | ") : "keine");
  await p.screenshot({ path: "slider.png", fullPage: true });
  await b.close();
})();
