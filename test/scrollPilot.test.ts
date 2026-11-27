import { test } from "node:test";
import assert from "node:assert";
import { ScrollPilot, chatScrollPlan, SETTLE_JUMP_DELAYS_MS, STICK_MAX_MS, MEASURE_SUPPRESS_MS, CONTENT_DEBOUNCE_MS, PREPEND_TTL_MS, BOTTOM_TOLERANCE_PX } from "../scrollPilot.ts";

/** Deterministische Uhr: Timer und Frames laufen in echtem Zeitverhältnis, aber ohne Wall-Clock. */
class FakeClock {
  t = 0;
  private seq = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  timer = (fn: () => void, ms: number) => {
    const id = this.seq++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimer = (id: number) => { this.timers.delete(id); };
  /** Ein Frame ist ein 0-ms-Timer — deterministisch, keine echte Render-Pipeline nötig. */
  frame = (fn: () => void) => this.timer(fn, 0);
  cancelFrame = (id: number) => { this.timers.delete(id); };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let next: { at: number; fn: () => void } | null = null;
      for (const [id, e] of this.timers) {
        if (e.at > end) continue;
        if (!next || e.at < next.at) { next = e; nextId = id; }
      }
      if (!next) break;
      this.timers.delete(nextId);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
  }
  pendingTimers() { return this.timers.size; }
}

function makePilot() {
  const clock = new FakeClock();
  const calls: { type: "end" | "offset"; y?: number; t: number }[] = [];
  const pilot = new ScrollPilot({
    now: clock.now,
    timer: clock.timer,
    clearTimer: clock.clearTimer,
    frame: clock.frame,
    cancelFrame: clock.cancelFrame,
    scrollToEnd: () => calls.push({ type: "end", t: clock.t }),
    scrollToOffset: (y: number) => calls.push({ type: "offset", y, t: clock.t }),
  });
  const ends = () => calls.filter((c) => c.type === "end").length;
  const offsets = () => calls.filter((c) => c.type === "offset");
  /** Jeder Sprung ist entweder scrollToEnd (noch keine Geometrie) ODER scrollToOffset. */
  const jumps = () => calls.filter((c) => c.type === "end" || c.type === "offset").length;
  return { clock, pilot, calls, ends, offsets, jumps };
}

const GEO = (offsetY: number, height: number, viewport = 800) => ({ offsetY, height, viewport });

test("ScrollPilot.open: springt an den dokumentierten Punkten ans Ende", () => {
  const { clock, pilot, ends } = makePilot();
  pilot.open("c1");
  clock.advance(0);
  assert.strictEqual(ends(), 1, "Sprung 0 ms");
  clock.advance(120);
  assert.strictEqual(ends(), 2, "Sprung 120 ms");
  clock.advance(380);
  assert.strictEqual(ends(), 3, `Sprung ${SETTLE_JUMP_DELAYS_MS[2]} ms`);
  assert.strictEqual(pilot.isSticking("c1"), true, "Stick-Modus läuft noch (Notanker 8 s)");
});

test("ScrollPilot: Höhenänderungen ziehen im Stick-Modus IMMER nach unten (Ursprungsfehler)", () => {
  const { clock, pilot, ends } = makePilot();
  pilot.open("c1");
  clock.advance(1000); // alle geplanten Sprünge durch — alter Code war hier fertig
  const before = ends();
  // FlatList-Batches, Server-Verlauf, Bild/DIL-Layout: 10 Änderungen nach 1 s
  for (let i = 1; i <= 10; i++) {
    pilot.onContentSizeChange("c1", 1000 * i);
    clock.advance(16);
  }
  assert.strictEqual(ends() - before, 10, "jede Höhenänderung erzeugt einen Sprung");
  assert.strictEqual(pilot.isNearBottom("c1"), true);
});

test("ScrollPilot.drag: Finger-Geste stoppt laufende Sprünge sofort (kein Zurückreißen)", () => {
  const { clock, pilot, ends } = makePilot();
  pilot.open("c1");
  clock.advance(0); // 1. Sprung gelaufen
  assert.strictEqual(ends(), 1);
  pilot.drag("c1");
  clock.advance(5000);
  assert.strictEqual(ends(), 1, "120/500-ms-Sprünge dürfen nach der Geste NICHT mehr feuern");
  assert.strictEqual(pilot.isSticking("c1"), false);
  assert.strictEqual(pilot.pending().timers, 0, "keine offenen Timer mehr");
});

test("ScrollPilot.drag: bricht auch einen geplanten Frame ab", () => {
  const { clock, pilot, ends } = makePilot();
  pilot.open("c1");
  clock.advance(0);
  const before = ends();
  pilot.onContentSizeChange("c1", 2000); // plant Frame
  pilot.drag("c1"); // Geste kommt VOR dem Frame
  clock.advance(100);
  assert.strictEqual(ends(), before, "abgebrochener Frame darf nicht springen");
});

test("ScrollPilot: Chat-Wechsel lässt den alten Chat nicht weiter springen", () => {
  const { clock, pilot, ends } = makePilot();
  pilot.open("c1");
  clock.advance(50);
  pilot.open("c2"); // Nutzer tippt in der Liste den nächsten Chat
  assert.strictEqual(pilot.isSticking("c1"), false, "alter Chat ist nicht mehr sticky");
  const before = ends();
  clock.advance(600);
  // c2 bekommt 0/120/500 → 3 Sprünge, c1 keinen weiteren
  assert.strictEqual(ends() - before, 3);
});

test("ScrollPilot: Notanker beendet den Stick-Modus nach 8 s", () => {
  const { clock, pilot } = makePilot();
  pilot.open("c1");
  clock.advance(STICK_MAX_MS - 1);
  assert.strictEqual(pilot.isSticking("c1"), true);
  clock.advance(1);
  assert.strictEqual(pilot.isSticking("c1"), false);
  // Nach dem Notanker misst onScroll wieder echt: oben gelesen → nearBottom false
  pilot.onScroll("c1", GEO(100, 5000));
  assert.strictEqual(pilot.isNearBottom("c1"), false, "Sperrfenster ist längst abgelaufen");
});

test("ScrollPilot.onScroll: Zwischenstände während des Sprungfensters kippen nearBottom nicht", () => {
  const { clock, pilot } = makePilot();
  pilot.open("c1");
  const lastJump = SETTLE_JUMP_DELAYS_MS[SETTLE_JUMP_DELAYS_MS.length - 1];
  clock.advance(lastJump); // alle drei Sprünge gelaufen, letzter Sperrt bis lastJump+120
  // Stick-Modus beenden (Geste), sonst blockiert er die Messung unabhängig vom Zeitfenster —
  // geprüft werden soll hier NUR das Sperrfenster nach einem Sprung.
  pilot.drag("c1");
  pilot.onScroll("c1", GEO(1200, 5000)); // weit weg vom Ende (Zwischenstand des Layouts)
  assert.strictEqual(pilot.isNearBottom("c1"), true, "Sperrfenster schützt vor Fehlmessung");
  clock.advance(MEASURE_SUPPRESS_MS);
  pilot.onScroll("c1", GEO(1200, 5000));
  assert.strictEqual(pilot.isNearBottom("c1"), false, "nach dem Fenster misst onScroll wieder echt");
});

test("ScrollPilot.onScroll: oben gelesen → keine automatischen Sprünge mehr", () => {
  const { clock, pilot, ends } = makePilot();
  pilot.open("c1");
  clock.advance(STICK_MAX_MS + MEASURE_SUPPRESS_MS + 1);
  pilot.onScroll("c1", GEO(500, 5000)); // Nutzer ist oben
  const before = ends();
  pilot.onContentSizeChange("c1", 5200);
  clock.advance(200);
  assert.strictEqual(ends(), before, "Nutzer liest oben — Ansicht darf nicht nach unten gerissen werden");
});

test("ScrollPilot: Auto-Follow beim Streamen bleibt aktiv (unterste Position, Deltas alle 16 ms)", () => {
  const { clock, pilot, jumps } = makePilot();
  pilot.open("c1");
  clock.advance(STICK_MAX_MS + MEASURE_SUPPRESS_MS + 1);
  pilot.onScroll("c1", GEO(4200, 5000)); // exakt unten (dist 0)
  const before = jumps();
  for (let i = 0; i < 20; i++) {
    pilot.onContentSizeChange("c1", 5000 + 10 * (i + 1));
    clock.advance(16);
  }
  assert.ok(jumps() - before >= 5, `Follow muss greifen (war ${jumps() - before} Sprünge), nicht jeder Delta einzeln`);
});

test("ScrollPilot: kein Restabstand — Sprung geht auf das gemessene Maximum, nicht via scrollToEnd", () => {
  const { clock, pilot, offsets, ends } = makePilot();
  pilot.open("c1");
  // Geometrie liegt vor (onScroll misst Höhe + Viewport)
  pilot.onScroll("c1", GEO(1000, 6000, 800));
  const endsBefore = ends();
  clock.advance(120); // nächster geplanter Siedlungssprung
  assert.strictEqual(ends(), endsBefore, "scrollToEnd (ignoriert paddingBottom) darf hier nicht mehr laufen");
  const ys = offsets().map((o) => o.y);
  assert.ok(ys.length >= 1 && ys.every((y) => y === 5200), `5200 = 6000 - 800 (absolutes Listenende), war ${JSON.stringify(ys)}`);
  assert.strictEqual(pilot.distanceToBottom("c1"), 0, "Restabstand muss 0 sein");
});

test("ScrollPilot: ohne gemessene Geometrie bleibt scrollToEnd der Startpunkt", () => {
  const { clock, pilot, ends, offsets } = makePilot();
  pilot.open("c1");
  clock.advance(0);
  assert.strictEqual(ends(), 1, "erster Sprung ohne Messung → nativer Weg");
  assert.strictEqual(offsets().length, 0);
});

test("ScrollPilot: kein Offset-Sprung, wenn der Inhalt kürzer als der Viewport ist", () => {
  const { clock, pilot, offsets } = makePilot();
  pilot.open("c1");
  pilot.onScroll("c1", GEO(0, 400, 800)); // Chat kürzer als der Schirm → nichts zu scrollen
  clock.advance(120);
  assert.deepStrictEqual(offsets().map((o) => o.y), [], "negatives/0-Maximum darf keinen Offset auslösen");
});

test("ScrollPilot.beginPrepend: ältere Nachrichten oben verändern die Leseposition nicht", () => {
  const { clock, pilot, offsets } = makePilot();
  pilot.open("c1");
  clock.advance(STICK_MAX_MS + MEASURE_SUPPRESS_MS + 1);
  pilot.onScroll("c1", GEO(600, 5000)); // mitten im Verlauf
  assert.strictEqual(pilot.isNearBottom("c1"), false);
  pilot.beginPrepend("c1");
  pilot.onContentSizeChange("c1", 8000); // +3000 durch nachgeladene ältere Nachrichten
  assert.deepStrictEqual(offsets().map((o) => o.y), [3600], "Offset um die neue Höhe korrigiert");
});

test("ScrollPilot.beginPrepend: steht der Nutzer unten, gewinnt der Stick-Modus (kein Offset-Sprung)", () => {
  const { clock, pilot, offsets, ends } = makePilot();
  pilot.open("c1");
  clock.advance(0);
  const before = ends();
  pilot.beginPrepend("c1");
  pilot.onContentSizeChange("c1", 9000);
  clock.advance(16);
  assert.strictEqual(offsets().length, 0, "kein Offset-Sprung, wenn der Nutzer unten steht");
  assert.strictEqual(ends() - before, 1, "stattdessen ans Ende springen");
});

test("ScrollPilot: keine Timer-/Frame-Leichen nach 8 s", () => {
  const { clock, pilot } = makePilot();
  pilot.open("c1");
  clock.advance(STICK_MAX_MS);
  assert.deepStrictEqual(pilot.pending(), { timers: 0, frames: 0 });
  assert.strictEqual(clock.pendingTimers(), 0);
});

test("ScrollPilot.close: bricht alles ab (Tab-Wechsel verlässt den Chat)", () => {
  const { clock, pilot } = makePilot();
  pilot.open("c1");
  clock.advance(0);
  pilot.close("c1");
  assert.deepStrictEqual(pilot.pending(), { timers: 0, frames: 0 });
  assert.strictEqual(pilot.isSticking("c1"), false);
});

test("ScrollPilot.beginPrepend: korrigiert auch bei offsetY === 0 (Text steht ganz oben)", () => {
  const { clock, pilot, offsets } = makePilot();
  pilot.open("c1");
  clock.advance(STICK_MAX_MS + MEASURE_SUPPRESS_MS + 1);
  pilot.onScroll("c1", GEO(0, 5000)); // ganz oben (offsetY 0)
  pilot.beginPrepend("c1");
  pilot.onContentSizeChange("c1", 8000); // +3000 vorne angehängt
  assert.deepStrictEqual(offsets().map((o) => o.y), [3000], "auch bei offsetY 0 muss um das Delta korrigiert werden");
});

test("ScrollPilot.beginPrepend: veralteter Hinweis wird NICHT als Prepend gedeutet (TTL)", () => {
  const { clock, pilot, offsets } = makePilot();
  pilot.open("c1");
  clock.advance(STICK_MAX_MS + MEASURE_SUPPRESS_MS + 1);
  pilot.onScroll("c1", GEO(600, 5000));
  pilot.beginPrepend("c1");
  clock.advance(PREPEND_TTL_MS + 1); // kein Merge passiert → Hinweis verfällt
  pilot.onContentSizeChange("c1", 8000);
  assert.strictEqual(offsets().length, 0, "ohne echten Prepend darf der Offset nicht verschoben werden");
});

test("ScrollPilot.beginPrepend: eine Geste verwirft den vorbereiteten Hinweis", () => {
  const { clock, pilot, offsets } = makePilot();
  pilot.open("c1");
  clock.advance(STICK_MAX_MS + MEASURE_SUPPRESS_MS + 1);
  pilot.onScroll("c1", GEO(600, 5000));
  pilot.beginPrepend("c1");
  pilot.drag("c1"); // Nutzer scrollt selbst
  pilot.onContentSizeChange("c1", 8000);
  assert.strictEqual(offsets().length, 0);
});

test("ScrollPilot.close ohne Argument räumt den offenen Chat auf (kein Karten-Wachstum)", () => {
  const { clock, pilot } = makePilot();
  pilot.open("c1");
  pilot.onScroll("c1", GEO(0, 1000));
  clock.advance(0);
  pilot.close();
  assert.deepStrictEqual(pilot.pending(), { timers: 0, frames: 0 });
  assert.strictEqual(pilot.isSticking("c1"), false);
  assert.strictEqual(pilot.distanceToBottom("c1"), -1, "Geometrie wurde verworfen");
});

test("ScrollPilot: Konstanten sind plausibel (Toleranz < Sprung-Grenze, Debounce < Sprungfenster)", () => {
  assert.ok(BOTTOM_TOLERANCE_PX > 0 && BOTTOM_TOLERANCE_PX < 200);
  assert.ok(CONTENT_DEBOUNCE_MS > 0 && CONTENT_DEBOUNCE_MS < MEASURE_SUPPRESS_MS);
});

// --- chatScrollPlan (pure Entscheidungsfunktion, vom Pilot genutzt) -------------
test("chatScrollPlan: Stick-Modus klebt am Ende, egal was onScroll meldet", () => {
  const p = chatScrollPlan({ now: 1000, autoScrollUntil: 0, sticking: true, nearBottom: false });
  assert.deepStrictEqual(p, { measure: false, pin: true, debounce: false });
});

test("chatScrollPlan: während eines Sprungs bleibt auch debounce stumm (kein Animationsabbruch)", () => {
  const p = chatScrollPlan({ now: 1500, autoScrollUntil: 1700, sticking: false, nearBottom: true });
  assert.deepStrictEqual(p, { measure: false, pin: false, debounce: false });
});

test("chatScrollPlan: nach dem Sprung misst onScroll wieder, oben gelesen = kein Auto-Scroll", () => {
  const p = chatScrollPlan({ now: 2000, autoScrollUntil: 1700, sticking: false, nearBottom: false });
  assert.deepStrictEqual(p, { measure: true, pin: false, debounce: false });
});

test("chatScrollPlan: unten stehend → debounce, Grenze now === autoScrollUntil misst wieder", () => {
  assert.deepStrictEqual(chatScrollPlan({ now: 5000, autoScrollUntil: 0, sticking: false, nearBottom: true }), { measure: true, pin: false, debounce: true });
  assert.strictEqual(chatScrollPlan({ now: 1700, autoScrollUntil: 1700, sticking: false, nearBottom: true }).measure, true);
});

test("chatScrollPlan: pin und measure nie gleichzeitig, debounce exakt definiert (alle Kombinationen)", () => {
  for (const sticking of [true, false]) {
    for (const nearBottom of [true, false]) {
      for (const [now, until] of [[1000, 0], [1500, 1700], [1700, 1700]]) {
        const p = chatScrollPlan({ now, autoScrollUntil: until, sticking, nearBottom });
        assert.ok(!(p.pin && p.measure), `pin+measure bei ${sticking}/${nearBottom}/${now}/${until}`);
        assert.strictEqual(p.pin, sticking);
        assert.strictEqual(p.debounce, !sticking && nearBottom && now >= until);
      }
    }
  }
});

test("ScrollPilot.jump: Geometrie wird nachgeführt (distanceToBottom 0 statt altem Abstand)", () => {
  const { clock, pilot } = makePilot();
  pilot.open("c1");
  pilot.onScroll("c1", { offsetY: 3000, height: 5000, viewport: 800 }); // Abstand 1200
  assert.strictEqual(pilot.distanceToBottom("c1"), 1200);
  clock.advance(500); // letzter Settle-Jump
  assert.strictEqual(pilot.distanceToBottom("c1"), 0, "nach dem Sprung steht die Liste unten");
});

test("ScrollPilot: mehrere Höhenänderungen im selben Tick = EIN Sprung (Single-Flight)", () => {
  const { clock, pilot, ends } = makePilot();
  pilot.open("c1");
  clock.advance(1000); // Stick-Modus aktiv, keine Timer mehr offen
  const before = ends();
  pilot.onContentSizeChange("c1", 1000);
  pilot.onContentSizeChange("c1", 1100);
  pilot.onContentSizeChange("c1", 1200);
  clock.advance(16);
  assert.strictEqual(ends() - before, 1, "drei Änderungen, aber nur ein scrollToEnd");
});

test("hasUserScrolled: erst gemessene Aufwaertsbewegung gibt frei, Beruehrung allein nicht", () => {
  const { pilot } = makePilot();
  pilot.open("c1");
  pilot.onScroll("c1", GEO(500, 4000));
  pilot.drag("c1"); // onScrollBeginDrag feuert schon beim Antippen
  assert.strictEqual(pilot.hasUserScrolled("c1"), false, "blosse Beruehrung gibt NICHT frei");
  // nach unten gewischt = kein Verlaufs-Interesse
  pilot.onScroll("c1", GEO(560, 4000));
  assert.strictEqual(pilot.hasUserScrolled("c1"), false);
  // 20 pt nach oben (Start war 500): noch unter der Schwelle
  pilot.onScroll("c1", GEO(480, 4000));
  assert.strictEqual(pilot.hasUserScrolled("c1"), false);
  // 24 pt nach oben: frei
  pilot.onScroll("c1", GEO(476, 4000));
  assert.strictEqual(pilot.hasUserScrolled("c1"), true);
  // neuer Chat erbt das Flag nicht, alter wird vergessen
  pilot.open("c2");
  assert.strictEqual(pilot.hasUserScrolled("c2"), false);
  assert.strictEqual(pilot.hasUserScrolled("c1"), false);
});

test("hasUserScrolled: am Listenanfang (offsetY=0) zaehlt der iOS-Ueberscroll als Aufwaertsbewegung", () => {
  const { pilot } = makePilot();
  pilot.open("c1");
  pilot.onScroll("c1", GEO(0, 4000));
  pilot.drag("c1");
  pilot.onScroll("c1", GEO(-10, 4000)); // Bounce, noch unter der Schwelle
  assert.strictEqual(pilot.hasUserScrolled("c1"), false);
  pilot.onScroll("c1", GEO(-30, 4000));
  assert.strictEqual(pilot.hasUserScrolled("c1"), true);
});

test("hasUserScrolled: close() raeumt das Flag auf", () => {
  const { pilot } = makePilot();
  pilot.open("c1");
  pilot.onScroll("c1", GEO(500, 4000));
  pilot.drag("c1");
  pilot.onScroll("c1", GEO(400, 4000));
  assert.strictEqual(pilot.hasUserScrolled("c1"), true);
  pilot.close("c1");
  assert.strictEqual(pilot.hasUserScrolled("c1"), false);
});
