const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 2400 } });
  const err = [];
  p.on("pageerror", (e) => err.push(String(e).split("\n")[0]));
  p.on("console", (m) => { if (m.type() === "error") err.push(m.text().slice(0, 150)); });
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(1500);
  const t = await p.locator("body").innerText();
  console.log("Passwort-Reset da:", /Passwort-Reset/.test(t), "| Knoten antippbar:", /Knoten antippbar/.test(t), "| img:", await p.locator("img").count());
  const imgs = await p.locator("img").evaluateAll((els)=>els.map(e=>e.getAttribute("src")+" "+e.clientWidth+"x"+e.clientHeight));
  console.log("bilder:", imgs.join(" | ").slice(0,200));
  console.log("errors:", err.slice(0,4).join(" || ") || "keine");
  await b.close();
})();
