const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
const stand = (p) => p.evaluate(() => [...document.querySelectorAll('[role="radio"],[role="checkbox"],input[type="checkbox"]')]
  .map((e) => ({ role: e.getAttribute("role"), label: e.getAttribute("aria-label"), checked: e.getAttribute("aria-checked"), sel: e.getAttribute("aria-selected") })));
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 1000 } });
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(900);
  console.log("A VOR  :", JSON.stringify(await stand(p)));
  await p.locator('[aria-label="Kosten zeigen"]').first().click();
  await p.waitForTimeout(250);
  console.log("B CHECK:", JSON.stringify(await stand(p)));
  await p.locator('[aria-label="Wein"]').first().click();
  await p.waitForTimeout(250);
  console.log("C RADIO:", JSON.stringify(await stand(p)));
  console.log("D TEXT :", (await p.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 150));
  await b.close();
})();
