const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 1180 } });
  const fehler = [];
  p.on("pageerror", (e) => fehler.push(String(e).split("\n")[0]));
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(900);
  const box = await p.locator('[aria-label="Bier pro Woche"]').first().boundingBox();
  await p.mouse.move(box.x + box.width * 0.24, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  await p.locator('[aria-label="gesamt"]').first().click();
  await p.locator('[aria-label="Wein"]').first().click();
  await p.waitForTimeout(400);
  const aria = await p.evaluate(() => {
    const s = document.querySelector('[role="slider"]');
    return { now: s && s.getAttribute("aria-valuenow"), min: s && s.getAttribute("aria-valuemin"), max: s && s.getAttribute("aria-valuemax") };
  });
  console.log("SLIDER-ARIA:", JSON.stringify(aria));
  console.log("FEHLER:", fehler.length ? fehler.join(" | ") : "keine");
  await p.screenshot({ path: "final.png", fullPage: true });
  await b.close();
})();
