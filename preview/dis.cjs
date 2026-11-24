const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 1180 } });
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(800);
  const wert = () => p.evaluate(() => document.querySelectorAll('[role="slider"]')[1]?.getAttribute("aria-valuenow"));
  const vor = await wert();
  const box = await p.locator('[aria-label^="Trinkjahre"]').first().boundingBox();
  await p.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(400);
  for (const m of await p.locator('[aria-label*="Trinkjahre"]').all()) { /* Marken-Klick pruefen */ }
  console.log("DISABLED vor=" + vor + " nach-Drag=" + (await wert()) + " (muss gleich bleiben)");
  await b.close();
})();
