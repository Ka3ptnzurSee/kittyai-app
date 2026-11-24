const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 900 } });
  p.on("pageerror", (e) => console.log("PAGEERROR:", String(e).split("\n").slice(0, 3).join(" / ")));
  p.on("console", (m) => console.log("CONSOLE[" + m.type() + "]:", m.text().slice(0, 300)));
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(1500);
  console.log("HTML-LEN:", (await p.content()).length);
  console.log("BODY:", (await p.locator("body").innerText()).slice(0, 300));
  await b.close();
})();
