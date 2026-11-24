const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 2200 } });
  const err = [];
  p.on("pageerror", (e) => err.push(String(e).split("\n")[0]));
  p.on("console", (m) => { if (m.type() === "error") err.push("console: " + m.text().slice(0, 120)); });
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(1200);
  const t = await p.locator("body").innerText();
  console.log("Textlaenge:", t.length, "| enthaelt 'Knoten antippbar':", /Knoten antippbar/.test(t), "| Passwort-Reset:", /Passwort-Reset/.test(t));
  console.log("img-Elemente:", await p.locator("img").count());
  const imgs = await p.locator("img").evaluateAll((els) => els.map((e) => (e.getAttribute("src") || "").slice(0, 70) + " @" + e.clientWidth + "x" + e.clientHeight));
  console.log("Bilder:", imgs.slice(0, 4).join(" | "));
  console.log("Errors:", err.slice(0, 3).join(" | ") || "keine");
  await b.close();
})();
