const { chromium } = require("/opt/kitty/preview-tool/node_modules/playwright-core");
const txt = async (p) => (await p.locator("body").innerText()).replace(/\n+/g, " | ");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const p = await b.newPage({ viewport: { width: 460, height: 1100 } });
  const fehler = [];
  p.on("pageerror", (e) => fehler.push(String(e).split("\n")[0].slice(0, 160)));
  p.on("console", (m) => { if (m.type() === "error") fehler.push("console: " + m.text().slice(0, 160)); });
  await p.goto("http://127.0.0.1:8099/index.html");
  await p.waitForTimeout(1200);
  console.log("1 START : " + (await txt(p)).slice(0, 200));

  // Slider ziehen
  const box = await p.locator('[aria-label="Bier pro Woche"]').first().boundingBox();
  await p.mouse.move(box.x + box.width * 0.24, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  console.log("2 SLIDER: " + (await txt(p)).slice(0, 260));

  // Select-Option waehlen
  await p.locator('[aria-label="gesamt"]').first().click();
  await p.waitForTimeout(400);
  console.log("3 SELECT: " + (await txt(p)).slice(180, 420));

  // Checkbox togglen
  await p.locator('[aria-label="Kosten zeigen"]').first().click();
  await p.waitForTimeout(300);
  console.log("4 CHECK : " + (await txt(p)).slice(180, 420));

  // Radio
  await p.locator('[aria-label="Wein"]').first().click();
  await p.waitForTimeout(300);
  const radio = await p.locator('[role="radio"][aria-checked="true"], [role="radio"][aria-selected="true"]').count();
  console.log("5 RADIO : ausgewaehlte radios = " + radio);

  await p.screenshot({ path: "shot5.png", fullPage: true });
  console.log("FEHLER  : " + (fehler.length ? fehler.join(" || ") : "keine"));
  await b.close();
})();
