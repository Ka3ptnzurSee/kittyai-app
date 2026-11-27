// ScrollPilot — die komplette Chat-Scroll-Logik als eigenständige, testbare Einheit.
//
// Warum ein eigenes Modul (Befund 26.11.2026): Die Logik lag als Refs + Timer direkt in
// App.tsx und war damit nur auf einem echten iPhone prüfbar. Genau dort saßen die Fehler
// („Chat öffnet sich nicht unten", „lädt Nachrichten nach", „Springe nach dem
// Hochscrollen zurück"). Alle Abhängigkeiten (Uhr, Timer, Frame, Scroll-Aufrufe) werden
// injiziert — im Test läuft eine deterministische Fake-Clock, es gibt also KEIN
// Timing-Geflacker und keine Geräteabhängigkeit.
//
// Verhalten:
//  - open(): Chat klebt am Ende (Stick-Modus). Jede Höhenänderung zieht im nächsten Frame
//    wieder nach unten — egal ob FlatList-Batch, Server-Verlauf, Bild oder DIL-Block.
//  - drag(): eine echte Finger-Geste beendet den Stick-Modus SOFORT und bricht alle
//    geplanten Sprünge ab (auch den 500-ms-Notanker).
//  - notanker: ohne Geste endet der Stick-Modus nach STICK_MAX_MS (dauerhaft nachmessende
//    Elemente wie KaTeX-WebViews sollen nicht ewig nachziehen).
//  - beginPrepend(): hängt der Server-Sync ÄLTERE Nachrichten vorne an, während der Nutzer
//    oben liest, wird der Offset um die neue Höhe korrigiert (kein Sprung im Text).
//  - Nach dem Sprungfenster (MEASURE_SUPPRESS_MS) misst onScroll wieder normal.
/** So lange gilt ein beginPrepend()-Hinweis (danach ist er veraltet und wird verworfen). */
export const PREPEND_TTL_MS = 1000;

/** Abstand (pt) zum Listenende, ab dem „der Nutzer steht unten" gilt. */
export const BOTTOM_TOLERANCE_PX = 80;

/**
 * Scroll-Plan für die Chat-Liste (bewusst pur — damit ohne React-Native-Laufzeit testbar).
 *
 * Hintergrund (Befund 26.11.2026): Die Ansicht blieb beim Öffnen eines Chats mitten im
 * Verlauf stehen, weil drei feste Timer (80/300/800 ms) zu kurz waren. Danach ändert sich
 * die Höhe noch mehrfach: die FlatList rendert in Batches nach, `/api/session` ersetzt den
 * Verlauf, Bilder und DIL-Blöcke messen ihre Höhe erst im Layout. Die `onScroll`-Messwerte
 * aus dieser Zeit sind Zwischenstände und dürfen den „am Ende"-Zustand nicht kippen.
 *
 * @param now             Date.now() im Ereignis
 * @param autoScrollUntil Zeitstempel, bis zu dem ein programmatischer Sprung nachklingt
 * @param sticking        Chat klebt nach dem Öffnen am Listenende
 * @param nearBottom      Nutzer stand zuletzt am Ende (< 80 px)
 * @returns measure   onScroll darf `nearBottom` neu berechnen
 *          pin       Höhenänderung → sofort wieder ans Ende springen (Stick-Modus)
 *          debounce  Höhenänderung → nach 40 ms ans Ende springen (Nutzer stand unten)
 */
export function chatScrollPlan(s: {
  now: number;
  autoScrollUntil: number;
  sticking: boolean;
  nearBottom: boolean;
}): { measure: boolean; pin: boolean; debounce: boolean } {
  // Während eines laufenden Sprungs oder im Stick-Modus sind Messwerte Zwischenstände.
  const measure = s.now >= s.autoScrollUntil && !s.sticking;
  return {
    measure,
    // pin und measure schließen sich per Definition aus (pin ⟺ sticking, measure ⟹ !sticking).
    pin: s.sticking,
    // `debounce` muss das Sprung-Fenster respektieren: sonst feuerte 40 ms nach dem
    // ANIMIERTEN scrollToEnd aus send() ein non-animated scrollToEnd und brach die
    // Animation sichtbar ab (Review-Fund Runde 1). pin hat Vorrang (kein Doppel-Sprung).
    debounce: !s.sticking && s.nearBottom && s.now >= s.autoScrollUntil,
  };
}

/** Sprungpunkte nach dem Öffnen (ms). 0 = sofort, der Rest fängt späte Layouts ab. */
export const SETTLE_JUMP_DELAYS_MS: readonly number[] = [0, 120, 500];
/** Notanker: ohne Finger-Geste endet der Stick-Modus spätestens hier. */
export const STICK_MAX_MS = 15000;
/**
 * Ab dieser selbst gemessenen Aufwärtsbewegung (pt) gilt „der Nutzer scrollt zum Verlauf“.
 * Kleiner Wert = zu großzügig (Antippen lädt nach), größer = der erste echte Wisch fühlt
 * sich tot an. 24 pt liegt über dem iOS-Touch-Slop und unter einer halben Zeilenhöhe.
 */
export const SCROLL_INTENT_MIN_PX = 24;
/**
 * So lange gilt ein Geste-Start als aktuell, wenn das Geste-Ende nicht gemeldet wird.
 * Ohne diesen Verfall könnte ein reines Antippen später durch eine Layout-Änderung
 * (Tastatur, Verlauf schrumpft) als Aufwärts-Scrollen gelten (Review Runde 6, HIGH).
 */
export const DRAG_INTENT_TTL_MS = 1500;
/** So lange gelten onScroll-Messwerte nach einem programmatischen Sprung als Zwischenstand. */
export const MEASURE_SUPPRESS_MS = 120;
/** Sammel-Fenster für Höhenänderungen beim Streamen (nicht bei jedem Delta springen). */
export const CONTENT_DEBOUNCE_MS = 40;

export type PilotDeps = {
  now: () => number;
  scrollToEnd: () => void;
  scrollToOffset: (y: number) => void;
  timer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  frame: (fn: () => void) => number;
  cancelFrame: (id: number) => void;
};

function defaultDeps(): PilotDeps {
  return {
    now: () => Date.now(),
    scrollToEnd: () => {},
    scrollToOffset: () => {},
    timer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    frame: (fn) =>
      typeof requestAnimationFrame === "function"
        ? (requestAnimationFrame(fn) as unknown as number)
        : (setTimeout(fn, 0) as unknown as number),
    cancelFrame: (id) => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
      else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    },
  };
}

export type ScrollGeometry = { offsetY: number; height: number; viewport: number };

export class ScrollPilot {
  private deps: PilotDeps;
  private sticky = new Set<string>();
  /** Chats, in denen der Nutzer seit dem Öffnen selbst gescrollt hat (nur die dürfen nachladen). */
  private dragged = new Set<string>();
  /**
   * Beginn der laufenden Geste (nur für die Intent-Erkennung).
   * `y === null` = die Liste war beim Drag-Start noch nicht vermessen; der erste
   * onScroll-Wert wird dann als Startwert nachgezogen (sonst bliebe der Chat für den
   * Auto-Pfad dauerhaft gesperrt).
   */
  private dragStart = new Map<string, { y: number | null; at: number }>();
  private near = new Map<string, boolean>();
  private autoScrollUntil = 0;
  private timers = new Set<number>();
  private frames = new Set<number>();
  /** je Chat: zuletzt gemessene Geometrie (für Prepend-Korrektur). */
  private geo = new Map<string, ScrollGeometry>();
  /** je Chat: {height, offsetY, at} zum Zeitpunkt von beginPrepend(). */
  private prepend = new Map<string, { height: number; offsetY: number; at: number }>();
  private openChat: string | null = null;

  constructor(deps: Partial<PilotDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  // --- Zustand -------------------------------------------------------------
  isSticking(chatId: string): boolean {
    return this.sticky.has(chatId);
  }

  isNearBottom(chatId: string): boolean {
    // Default true: ein frisch geöffneter Chat gilt als „unten" (sonst klemmt Auto-Scroll).
    return this.near.get(chatId) ?? true;
  }

  setNearBottom(chatId: string, v: boolean): void {
    this.near.set(chatId, v);
  }

  lastGeometry(chatId: string): ScrollGeometry | undefined {
    return this.geo.get(chatId);
  }

  /** Abstand zum Listenende in pt (aus der letzten onScroll-Messung), -1 = noch keine. */
  distanceToBottom(chatId: string): number {
    const g = this.geo.get(chatId);
    if (!g) return -1;
    return Math.max(0, Math.round(g.height - (g.offsetY + g.viewport)));
  }

  /** Sofort ans Ende springen (Senden, Tastatur) und Messwerte kurz ausblenden. */
  jumpNow(chatId: string): void {
    this.jump(chatId);
  }

  /** Messwerte für `ms` ausblenden (für programmatische Scrolls außerhalb des Piloten). */
  suppressMeasure(ms: number): void {
    this.autoScrollUntil = this.deps.now() + ms;
  }

  /** Für Tests/Diagnose: wie viele Timer und Frames sind noch offen? */
  pending(): { timers: number; frames: number } {
    return { timers: this.timers.size, frames: this.frames.size };
  }

  // --- Ereignisse ----------------------------------------------------------
  /** Chat geöffnet: am Ende kleben, Sprünge planen, Notanker setzen. */
  open(chatId: string): void {
    this.cancelAll();
    this.openChat = chatId;
    // Ein Gerät hat immer nur EINEN aktiven Chat: alle alten Stick-Marken löschen, sonst
    // bleiben Chat-IDs dauerhaft im Set (Leak) und ein späterer Chat-Wechsel erbt sie.
    this.sticky.clear();
    this.sticky.add(chatId);
    this.dragged.clear();
    this.dragStart.clear();
    this.near.set(chatId, true);
    this.prepend.delete(chatId);
    for (const ms of SETTLE_JUMP_DELAYS_MS) this.scheduleJump(chatId, ms);
    const anchor = this.deps.timer(() => {
      this.timers.delete(anchor);
      this.sticky.delete(chatId);
      // Garantie (Befund 27.11.: „große Chats landen nie unten"): hat der Nutzer diesen
      // Chat nie selbst gescrollt, MUSS er unten stehen — auch wenn das Layout so spät
      // fertig wurde, dass alle geplanten Sprünge ins Leere liefen. Ohne diesen letzten
      // Schuss blieb die Liste bei großen, virtuell gerenderten Verläufen oben stehen.
      if (!this.dragged.has(chatId)) this.deps.scrollToEnd();
    }, STICK_MAX_MS);
    this.timers.add(anchor);
  }

  /** Chat verlassen/unmount: alles Offene abbrechen, Stick-Modus aus, Karten aufräumen. */
  close(chatId?: string): void {
    this.cancelAll();
    const target = chatId || this.openChat;
    if (target) {
      this.sticky.delete(target);
      this.dragged.delete(target);
      this.dragStart.delete(target);
      this.geo.delete(target);
      this.near.delete(target);
      this.prepend.delete(target);
    }
    this.openChat = null;
  }

  /** Echte Finger-Geste: Stick-Modus aus und geplante Sprünge abbrechen. */
  drag(chatId: string): void {
    this.cancelAll();
    this.sticky.delete(chatId);
    // Ein vorbereiteter Prepend-Hinweis darf eine spätere, echte Geste nicht verschieben.
    this.prepend.delete(chatId);
    // Ausgangspunkt merken — „gescrollt“ entscheidet erst die GEMESSENE Bewegung
    // (Review Runde 5: onScrollBeginDrag feuert schon bei der kleinsten Berührung).
    const g = this.geo.get(chatId);
    this.dragStart.set(chatId, { y: g ? g.offsetY : null, at: this.deps.now() });
  }

  /**
   * Geste beendet (onScrollEndDrag): ohne Bewegung war es ein Antippen — der Startwert
   * darf danach keine spätere, nicht-gestische Offset-Änderung mehr als „gescrollt“
   * auslegen (Tastatur öffnet → Viewport schrumpft → RN clampt offsetY).
   */
  endDrag(chatId: string): void {
    this.dragStart.delete(chatId);
  }

  /**
   * Hat der Nutzer diesen Chat seit dem Öffnen selbst nach oben gescrollt?
   *
   * Der automatische Nachlade-Pfad prüft das zusätzlich zum Stick-Modus (Befund 27.11.:
   * „beim Klick lädt es nach“). Eine blosse Berührung genügt NICHT: `onScrollBeginDrag`
   * feuert auch beim Antippen und beendet den Stick-Modus — danach stand die Liste bei
   * `offsetY≈0` und `shouldAutoLoadOlder` lud 60 ältere Nachrichten nach. Freigegeben wird
   * deshalb erst bei einer gemessenen Bewegung von mindestens `SCROLL_INTENT_MIN_PX`
   * nach oben (bei `offsetY === 0` fängt das den iOS-Überscroll/Bounce mit negativen Werten).
   */
  hasUserScrolled(chatId: string): boolean {
    return this.dragged.has(chatId);
  }

  /**
   * onScroll. Aktualisiert die Geometrie immer, den „am Ende"-Zustand nur, wenn es kein
   * Zwischenstand eines programmatischen Sprungs ist.
   */
  onScroll(chatId: string, g: ScrollGeometry): boolean {
    this.geo.set(chatId, g);
    // Gemessene Aufwärtsbewegung = der Nutzer will ältere Nachrichten sehen.
    const start = this.dragStart.get(chatId);
    if (start) {
      if (this.deps.now() - start.at > DRAG_INTENT_TTL_MS) {
        // Notanker, falls das Geste-Ende nicht gemeldet wurde.
        this.dragStart.delete(chatId);
      } else if (start.y === null) {
        start.y = g.offsetY; // erster Messwert nach dem Drag-Start
      } else if (g.offsetY <= start.y - SCROLL_INTENT_MIN_PX) {
        this.dragged.add(chatId);
        this.dragStart.delete(chatId);
      }
    }
    const plan = this.plan(chatId, g);
    if (!plan.measure) return false;
    const dist = g.height - (g.offsetY + g.viewport);
    const near = dist < BOTTOM_TOLERANCE_PX;
    this.near.set(chatId, near);
    return near;
  }

  /** Höhe hat sich geändert (Batch, Server-Verlauf, Bild, DIL-Block). */
  onContentSizeChange(chatId: string, height: number): void {
    const prev = this.geo.get(chatId);
    const g: ScrollGeometry = { offsetY: prev?.offsetY ?? 0, height, viewport: prev?.viewport ?? 0 };
    this.geo.set(chatId, g);

    // 1) Vorangestellte ältere Nachrichten: sichtbaren Text stehen lassen.
    //    Auch bei offsetY === 0 korrigieren: dort steht der Text ganz oben und würde
    //    sonst um das Delta nach unten geschoben (Review-Fund: Bedingung war > 0).
    //    Ein Eintrag gilt nur PREPEND_TTL_MS — ein später zufälliger Höhensprung darf
    //    nicht als Prepend missdeutet werden.
    const pending = this.prepend.get(chatId);
    if (pending && !this.sticky.has(chatId)) {
      this.prepend.delete(chatId);
      const delta = height - pending.height;
      if (this.deps.now() - pending.at <= PREPEND_TTL_MS && delta > 0) {
        this.deps.scrollToOffset(pending.offsetY + delta);
        this.geo.set(chatId, { ...g, offsetY: pending.offsetY + delta });
        // Eine laufende Geste wird um dieselbe Höhe mitverschoben, sonst erreicht der
        // echte Aufwärts-Wisch die 24-pt-Schwelle nicht (Review Runde 6, LOW).
        const drag = this.dragStart.get(chatId);
        if (drag && drag.y !== null) drag.y += delta;
        return; // Nutzer liest oben → NICHT ans Ende springen
      }
    }

    const plan = this.plan(chatId, g);
    if (plan.pin) {
      this.scheduleFrame(chatId);
      return;
    }
    if (!plan.debounce) return;
    this.scheduleJump(chatId, CONTENT_DEBOUNCE_MS);
  }

  /**
   * Höhe des sichtbaren Ausschnitts (FlatList-onLayout). Ohne diesen Wert bleibt
   * `viewport` 0, solange kein onScroll gefeuert hat — und dann kann `jump()` den
   * exakten Sprung nicht rechnen und fällt auf das unzuverlässige `scrollToEnd()`
   * zurück. Genau das traf große Chats beim Öffnen (kein Scroll-Event, weil die
   * Liste sofort ans Ende springen soll): sie landeten nie unten.
   */
  setViewport(chatId: string, viewport: number): void {
    if (!Number.isFinite(viewport) || viewport <= 0) return;
    const prev = this.geo.get(chatId);
    this.geo.set(chatId, {
      offsetY: prev?.offsetY ?? 0,
      height: prev?.height ?? 0,
      viewport,
    });
  }

  /**
   * Steht unmittelbar bevor, dass ältere Nachrichten VORNE angehängt werden
   * (`mergeServerTail` beim Session-Sync / Pull-to-Refresh)? Dann die aktuelle
   * Geometrie merken, damit onContentSizeChange den Offset korrigieren kann.
   */
  beginPrepend(chatId: string): void {
    const g = this.geo.get(chatId);
    if (!g) return;
    this.prepend.set(chatId, { height: g.height, offsetY: g.offsetY, at: this.deps.now() });
  }

  // --- intern --------------------------------------------------------------
  private plan(chatId: string, g: ScrollGeometry) {
    void g;
    return chatScrollPlan({
      now: this.deps.now(),
      autoScrollUntil: this.autoScrollUntil,
      sticking: this.sticky.has(chatId),
      nearBottom: this.isNearBottom(chatId),
    });
  }

  private scheduleJump(chatId: string, delay: number): void {
    const id = this.deps.timer(() => {
      this.timers.delete(id);
      this.jump(chatId);
    }, delay);
    this.timers.add(id);
  }

  private scheduleFrame(chatId: string): void {
    // Single-Flight: drei Höhenänderungen im selben Tick dürfen nicht drei scrollToEnd
    // auslösen (Review-Runde 4) — ein offener Frame reicht, er springt ohnehin ans Ende.
    if (this.frames.size > 0) return;
    const id = this.deps.frame(() => {
      this.frames.delete(id);
      this.jump(chatId);
    });
    this.frames.add(id);
  }

  private jump(chatId: string): void {
    this.autoScrollUntil = this.deps.now() + MEASURE_SUPPRESS_MS;
    this.near.set(chatId, true);
    // Geometrie nachführen: nach dem Sprung steht die Liste unten. Ohne das meldete
    // distanceToBottom() weiter den alten Abstand (Telemetrie-Fehldiagnose, Review-Runde 4).
    const g = this.geo.get(chatId);
    if (g) this.geo.set(chatId, { ...g, offsetY: Math.max(0, g.height - g.viewport) });
    // Restabstand-Fix (gemessen 26.11.2026, Build 136): RN 0.86 `scrollToEnd()` rechnet
    // `letzte Zelle.offset + Zelle.length + FooterLength - viewport` (VirtualizedList.js:135)
    // und ignoriert damit das `paddingBottom` des contentContainerStyle. Die Ansicht blieb
    // bei JEDEM scrollbaren Chat exakt 16 pt (= paddingBottom aus styles.listContent) über
    // dem Ende stehen — Geräte-Messung scroll_settle: 7× dist=16, nie 0. Sobald die echte
    // Geometrie gemessen ist (onScroll), wird deshalb auf das Maximum gescrollt; `scrollToEnd`
    // bleibt der Startpunkt, solange noch nichts gemessen wurde (Insets/Keyboard korrekt).
    if (g && g.viewport > 0 && g.height > g.viewport) {
      this.deps.scrollToOffset(g.height - g.viewport);
    } else {
      this.deps.scrollToEnd();
    }
  }

  private cancelAll(): void {
    for (const id of this.timers) this.deps.clearTimer(id);
    this.timers.clear();
    for (const id of this.frames) this.deps.cancelFrame(id);
    this.frames.clear();
  }
}
