// Feld-Performance-Messung der App.
//
// Zweck: die "gefühlt 2 s"-Beobachtung des Nutzers in echte Zahlen verwandeln —
// auf SEINEM Gerät, nicht auf dem Server (der war nie der Engpass: 0,8-41 ms).
//
// Es werden ausschliesslich Metrik-Name, Dauer in ms und eine kurze technische
// Zusatzinfo (z. B. Chat-Groesse) erfasst — kein Text, keine IDs, keine Inhalte.
// Gesammelt wird im Speicher und im Minutentakt an /api/diag geschickt
// (dort landet es in logs/perf.jsonl, abrufbar ueber GET /api/diag/perf).

export type PerfSample = { metric: string; ms: number; extra?: string };

const running = new Map<string, number>();
let samples: PerfSample[] = [];

/** Startzeitpunkt des Moduls = Beginn des App-Starts (Import-Zeit). */
export const moduleStartedAt = Date.now();

export function perfStart(metric: string): void {
  running.set(metric, Date.now());
}

/** Beendet eine Messung. Ohne vorheriges perfStart passiert nichts. */
export function perfEnd(metric: string, extra?: string): void {
  const t = running.get(metric);
  if (t === undefined) return;
  running.delete(metric);
  perfAdd(metric, Date.now() - t, extra);
}

export function perfAdd(metric: string, ms: number, extra?: string): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  samples.push({ metric, ms: Math.round(ms), extra: extra ? extra.slice(0, 40) : undefined });
  // Notbremse: nie mehr als 200 Messungen im Speicher halten.
  if (samples.length > 200) samples = samples.slice(-200);
}

/** Holt die gesammelten Messungen ab und leert den Puffer. */
export function takePerfSamples(): PerfSample[] {
  const out = samples;
  samples = [];
  return out;
}

export function pendingPerf(): number {
  return samples.length;
}
