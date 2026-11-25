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
export const STICK_MAX_MS = 8000;
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
  private near = new Map<string, boolean>();
  private autoScrollUntil = 0;
  private timers = new Set<number>();
  private frames = new Set<number>();
  /** je Chat: zuletzt gemessene Geometrie (für Prepend-Korrektur). */
  private geo = new Map<string, ScrollGeometry>();
  /** je Chat: {height, offsetY} zum Zeitpunkt von beginPrepend(). */
  private prepend = new Map<string, { height: number; offsetY: number }>();
  private notanker: number | null = null;
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
    this.near.set(chatId, true);
    this.prepend.delete(chatId);
    for (const ms of SETTLE_JUMP_DELAYS_MS) this.scheduleJump(chatId, ms);
    const anchor = this.deps.timer(() => {
      this.timers.delete(anchor);
      if (this.notanker === anchor) this.notanker = null;
      this.sticky.delete(chatId);
    }, STICK_MAX_MS);
    this.notanker = anchor;
    this.timers.add(anchor);
  }

  /** Chat verlassen/unmount: alles Offene abbrechen, Stick-Modus aus. */
  close(chatId?: string): void {
    this.cancelAll();
    if (chatId) this.sticky.delete(chatId);
    else if (this.openChat) this.sticky.delete(this.openChat);
    this.openChat = null;
  }

  /** Echte Finger-Geste: Stick-Modus aus und geplante Sprünge abbrechen. */
  drag(chatId: string): void {
    this.cancelAll();
    this.sticky.delete(chatId);
  }

  /**
   * onScroll. Aktualisiert die Geometrie immer, den „am Ende"-Zustand nur, wenn es kein
   * Zwischenstand eines programmatischen Sprungs ist.
   */
  onScroll(chatId: string, g: ScrollGeometry): boolean {
    this.geo.set(chatId, g);
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
    const pending = this.prepend.get(chatId);
    if (pending && !this.sticky.has(chatId)) {
      this.prepend.delete(chatId);
      const delta = height - pending.height;
      if (delta > 0 && pending.offsetY > 0) {
        this.deps.scrollToOffset(pending.offsetY + delta);
        this.geo.set(chatId, { ...g, offsetY: pending.offsetY + delta });
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
   * Steht unmittelbar bevor, dass ältere Nachrichten VORNE angehängt werden
   * (`mergeServerTail` beim Session-Sync / Pull-to-Refresh)? Dann die aktuelle
   * Geometrie merken, damit onContentSizeChange den Offset korrigieren kann.
   */
  beginPrepend(chatId: string): void {
    const g = this.geo.get(chatId);
    if (!g) return;
    this.prepend.set(chatId, { height: g.height, offsetY: g.offsetY });
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
      if (this.notanker === id) this.notanker = null;
      this.jump(chatId);
    }, delay);
    this.timers.add(id);
  }

  private scheduleFrame(chatId: string): void {
    const id = this.deps.frame(() => {
      this.frames.delete(id);
      this.jump(chatId);
    });
    this.frames.add(id);
  }

  private jump(chatId: string): void {
    this.autoScrollUntil = this.deps.now() + MEASURE_SUPPRESS_MS;
    this.near.set(chatId, true);
    this.deps.scrollToEnd();
  }

  private cancelAll(): void {
    for (const id of this.timers) this.deps.clearTimer(id);
    this.timers.clear();
    for (const id of this.frames) this.deps.cancelFrame(id);
    this.frames.clear();
    this.notanker = null;
  }
}
