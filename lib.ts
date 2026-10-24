// Reine, RN-unabhängige Helfer – extrahiert, damit sie ohne Expo getestet werden können.

// Kleiner inkrementeller UTF-8-Decoder (kein globaler TextDecoder nötig).
export class Utf8Decoder {
  private pending: number[] = [];
  private expected = 0;

  decode(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (this.expected === 0) {
        if (b < 0x80) out += String.fromCharCode(b);
        else if ((b >> 5) === 0b110) { this.pending = [b]; this.expected = 1; }
        else if ((b >> 4) === 0b1110) { this.pending = [b]; this.expected = 2; }
        else if ((b >> 3) === 0b11110) { this.pending = [b]; this.expected = 3; }
        else out += "\uFFFD";
      } else {
        this.pending.push(b);
        this.expected--;
        if (this.expected === 0) out += this.flush();
      }
    }
    return out;
  }

  private flush(): string {
    const p = this.pending;
    this.pending = [];
    let cp: number;
    if (p.length === 2) cp = ((p[0] & 0x1f) << 6) | (p[1] & 0x3f);
    else if (p.length === 3) cp = ((p[0] & 0x0f) << 12) | ((p[1] & 0x3f) << 6) | (p[2] & 0x3f);
    else cp = ((p[0] & 0x07) << 18) | ((p[1] & 0x3f) << 12) | ((p[2] & 0x3f) << 6) | (p[3] & 0x3f);
    if (cp > 0xffff) {
      cp -= 0x10000;
      return String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
    return String.fromCharCode(cp);
  }
}

export function argSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  if (typeof a.url === "string") return a.url;
  const keys = Object.keys(a);
  if (keys.length) {
    const v = a[keys[0]];
    if (typeof v === "string") return v.slice(0, 60);
    return keys[0];
  }
  return "";
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

// Eindeutige ID mit Zeitstempel + Zufall – verhindert Kollisionen,
// wenn mehrere Elemente in derselben Millisekunde erzeugt werden.
export function uid(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Routinen/Zeitpläne – Claude-iOS-Pendant („Routines“): 5-Feld-Cron
// (Minute Stunde TagImMonat Monat Wochentag; 0=Sonntag)
// ---------------------------------------------------------------------------

export type CronPreset = "hourly" | "daily" | "weekdays" | "weekend" | "weekly" | "monthly";

export const WEEKDAYS_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/** Cron-Ausdruck aus einem Preset bauen. `time` = "HH:MM", `day` = 0..6 (0=So). */
export function presetCron(
  preset: CronPreset,
  opts?: { time?: string; day?: number; dayOfMonth?: number },
): string {
  const [h, m] = (opts?.time || "09:00").split(":").map((x) => Number(x) || 0);
  const hour = Math.min(23, Math.max(0, h));
  const minute = Math.min(59, Math.max(0, m));
  const day = Math.min(6, Math.max(0, opts?.day ?? 1));
  const dayOfMonth = Math.min(31, Math.max(1, opts?.dayOfMonth ?? 1));
  switch (preset) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekend":
      return `${minute} ${hour} * * 0,6`;
    case "weekly":
      return `${minute} ${hour} * * ${day}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

/** Lesbare deutsche Beschriftung für einen 5-Feld-Cron-Ausdruck. */
export function cronLabel(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, month, dow] = parts;
  const hh = hour.padStart(2, "0");
  const mm = min.padStart(2, "0");
  const time = `${hh}:${mm}`;
  const simple = /^\d+$/.test(min) && /^\d+$/.test(hour);
  if (min === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "stündlich";
  if (!simple) return cron;
  if (dom === "*" && month === "*" && dow === "*") return `täglich um ${time}`;
  if (dom === "*" && month === "*" && dow === "1-5") return `wochentags um ${time}`;
  if (dom === "*" && month === "*" && (dow === "0,6" || dow === "6,0")) return `am Wochenende um ${time}`;
  if (dom === "*" && month === "*" && /^[0-6]$/.test(dow)) return `jeden ${WEEKDAYS_DE[Number(dow)]} um ${time}`;
  if (dom !== "*" && month === "*" && dow === "*" && /^\d+$/.test(dom)) return `monatlich am ${dom}. um ${time}`;
  return cron;
}
