const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 2200 } });
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(1200);
  console.log(JSON.stringify((await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700)));
  await b.close();
})();
