// DIL-Runtime: State-Store + Action-Interpreter (ChatGPT/Valdi-Vertrag, v1-Stufe).
//
// Bewusst OHNE react-native und OHNE eigenen CEL-Parser-Import (der Evaluator wird
// injiziert) — dadurch in `node --experimental-strip-types --test` direkt testbar.
//
// Vertrag (aus /opt/chatgpt-re/docs/20-dil-contract.md, Abschnitt 3):
//   gap        → statischer Wert
//   $gap       → dynamischer CEL-Ausdruck
//   gapAction  → Sandbox-Callback  (DAS hier)
//
// Eine Action ist die deklarative Kurzform dessen, was ChatGPT in QuickJS laufen
// lässt. Wir führen KEIN Fremd-JS aus (kein eval/new Function), sondern nur eine
// geprüfte Teilmenge:
//
//   state.metric = value                       ← Zuweisung, RHS = CEL-Ausdruck
//   state.hover = event.point
//   state.count += 1
//   invokeDILCallbackWithResult('askModel', 'Erkläre ' + state.metric)   ← Effekt
//   sendMessage('...') / askModel('...')       ← Kurzformen desselben Effekts
//
// Alles, was nicht in die Grammatik passt, wird als Fehler zurückgegeben — nie geworfen.

// ───────────────────────────── Typen ─────────────────────────────

export type DilValue = unknown;

export interface DilRuntime {
  state: Record<string, unknown>;
  appData: unknown;
  constants: Record<string, unknown>;
}

export interface DilActionEffect {
  kind: "message";
  /** Callback-Name aus invokeDILCallbackWithResult (z. B. "askModel"). */
  name: string;
  /** Fertig ausgewerteter Text, den die App an das Modell schickt. */
  text: string;
}

export interface DilActionContext {
  /** Aktueller Widget-Wert (Select/Radio/Checkbox/Slider/Input) → `value`. */
  value?: DilValue;
  /** Ereignis-Daten (Chart-Hover/Klick) → `event`. */
  event?: Record<string, unknown>;
  /** `item` / `index` innerhalb von Each. */
  item?: DilValue;
  index?: number;
  /** Zusätzlicher CEL-Scope (z. B. Each-Variablen). */
  scope?: Record<string, unknown>;
}

export interface DilActionResult {
  rt: DilRuntime;
  effects: DilActionEffect[];
  error?: string;
}

/** Signatur des CEL-Evaluators (in Dil.tsx: `evalCel` aus ./dil). */
export type DilExpressionEvaluator = (expression: string, scope: Record<string, unknown>) => unknown;

// ───────────────────────────── Grenzen (Adversarial-Härtung) ─────────────────────────────

const MAX_ACTION_LEN = 4000;
const MAX_STATEMENTS = 20;
const MAX_EFFECTS = 5;
const MAX_PATH_DEPTH = 6;
const MAX_EFFECT_TEXT = 4000;

// ───────────────────────────── Konstruktion ─────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cloneState(state: Record<string, unknown>): Record<string, unknown> {
  // Flache Kopie reicht: Zuweisungen erzeugen neue Objekte entlang des Pfads.
  return { ...state };
}

/** Neuen Runtime-Zustand anlegen. `appData`/`constants` werden defensiv bereinigt. */
export function createRuntime(appData?: unknown, constants?: unknown): DilRuntime {
  return {
    state: {},
    appData: appData ?? null,
    constants: isPlainObject(constants) ? constants : {},
  };
}

/** CEL-Scope für den aktuellen Runtime-Zustand bauen. */
export function runtimeScope(rt: DilRuntime, ctx?: DilActionContext): Record<string, unknown> {
  return {
    ...(ctx?.scope ?? {}),
    state: rt.state,
    appData: rt.appData,
    constants: rt.constants,
    value: ctx?.value,
    event: ctx?.event,
    item: ctx?.item,
    index: ctx?.index,
  };
}

/** Pfad-Segmente, die Prototype-Manipulation/Pollution erlauben würden. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** True, wenn der Pfad ein verbotenes Segment enthält (Prototype-Pollution). */
export function isSafePath(path: string): boolean {
  const segs = path.split(".").filter(Boolean);
  return segs.length > 0 && segs.length <= MAX_PATH_DEPTH && segs.every((s) => !FORBIDDEN_SEGMENTS.has(s));
}

/** Wert an einem Punkt-Pfad lesen (`a.b.0.c`). */
export function getAtPath(root: unknown, path: string): unknown {
  if (!path) return root;
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) ? cur[i] : undefined;
      continue;
    }
    if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }
  return cur;
}

/** Wert an einem Punkt-Pfad immutable setzen. Max. `MAX_PATH_DEPTH` Segmente. */
export function setAtPath(root: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  if (!isSafePath(path)) return root;
  const segs = path.split(".").filter(Boolean);
  const out = { ...root };
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next: unknown = cur[seg];
    const copy: Record<string, unknown> = isPlainObject(next) ? { ...next } : {};
    cur[seg] = copy;
    cur = copy;
  }
  cur[segs[segs.length - 1]] = value;
  return out;
}

// ───────────────────────────── Action-String zerlegen ─────────────────────────────

/** Statements an `;` trennen — aber nur auf Klammer-Tiefe 0 und außerhalb von Quotes. */
function splitStatements(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const ASSIGN_RE = /^state(\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(\+=|-=|=)\s*([\s\S]*)$/;
const CALLBACK_RE = /^(invokeDILCallbackWithResult|sendMessage|askModel)\s*\(([\s\S]*)\)$/;

/** Argumente einer Callback-Klammer splitten (Klammer-Tiefe, Quotes respektieren). */
function splitArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = src.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** String-Literal oder CEL-Ausdruck zu Text auswerten. */
function asText(expr: string, evaluate: DilExpressionEvaluator, scope: Record<string, unknown>): string {
  const v = evaluate(expr, scope);
  if (v == null) return "";
  return String(v).slice(0, MAX_EFFECT_TEXT);
}

// ───────────────────────────── Kern: Action ausführen ─────────────────────────────

/**
 * Eine Action gegen den Runtime-Zustand ausführen.
 * Gibt neuen Runtime-Zustand + Effekte (z. B. Follow-up-Nachricht an das Modell)
 * + optionalen Fehler zurück. Wirft nie.
 */
export function applyAction(
  rt: DilRuntime,
  action: string,
  evaluate: DilExpressionEvaluator,
  ctx: DilActionContext = {},
): DilActionResult {
  const noop: DilActionResult = { rt, effects: [] };
  if (typeof action !== "string") return { ...noop, error: "Action ist kein String" };
  const src = action.trim();
  if (!src) return noop;
  if (src.length > MAX_ACTION_LEN) return { ...noop, error: `Action zu lang (> ${MAX_ACTION_LEN})` };

  const statements = splitStatements(src);
  if (statements.length > MAX_STATEMENTS) {
    return { ...noop, error: `Zu viele Statements (> ${MAX_STATEMENTS})` };
  }

  let state = cloneState(rt.state);
  const effects: DilActionEffect[] = [];
  const errors: string[] = [];

  for (const stmt of statements) {
    const scope: Record<string, unknown> = {
      ...runtimeScope({ ...rt, state }, ctx),
    };

    // (a) Zuweisung: state.pfad = / += / -=
    const assign = ASSIGN_RE.exec(stmt);
    if (assign) {
      const [, path, op, rhsRaw] = assign;
      const rhsExpr = rhsRaw.trim();
      if (!isSafePath(path.slice(1))) {
        errors.push(`Unsicherer/zu tiefer Pfad: ${path}`);
        continue;
      }
      if (!rhsExpr) {
        errors.push(`Leere Zuweisung: ${stmt}`);
        continue;
      }
      let value: unknown;
      try {
        value = evaluate(rhsExpr, scope);
      } catch (e) {
        errors.push(`Ausdruck fehlerhaft: ${rhsExpr} (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      if (op !== "=") {
        const prev = getAtPath(state, path.slice(1));
        if (typeof prev !== "number" || typeof value !== "number") {
          errors.push(`${op} braucht Zahlen: ${stmt}`);
          continue;
        }
        value = op === "+=" ? prev + value : prev - value;
      }
      state = setAtPath(state, path.slice(1), value);
      continue;
    }

    // (b) Callback → Effekt (Follow-up-Frage an das Modell)
    const call = CALLBACK_RE.exec(stmt);
    if (call) {
      const fn = call[1];
      const args = splitArgs(call[2]);
      let name = "askModel";
      let textExpr: string;
      if (fn === "invokeDILCallbackWithResult") {
        if (args.length < 2) {
          errors.push(`invokeDILCallbackWithResult braucht (name, ausdruck): ${stmt}`);
          continue;
        }
        try {
          name = String(evaluate(args[0], scope) ?? "askModel").slice(0, 64);
        } catch {
          name = args[0].replace(/^['"`]|['"`]$/g, "").slice(0, 64);
        }
        textExpr = args[1];
      } else {
        textExpr = args[0] ?? "''";
      }
      let text: string;
      try {
        text = asText(textExpr, evaluate, scope);
      } catch (e) {
        errors.push(`Callback-Argument fehlerhaft: ${textExpr} (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      if (!text.trim()) {
        errors.push("Callback-Text ist leer");
        continue;
      }
      if (effects.length >= MAX_EFFECTS) {
        errors.push(`Zu viele Callbacks (> ${MAX_EFFECTS})`);
        continue;
      }
      effects.push({ kind: "message", name, text });
      continue;
    }

    // (c) Alles andere: bewusst nicht ausgeführt (kein eval, keine Funktionen, kein Netz).
    errors.push(`Nicht erlaubtes Statement (nur state-Zuweisungen + Callbacks): ${stmt}`);
  }

  const result: DilActionResult = { rt: { ...rt, state }, effects };
  if (errors.length) result.error = errors.join(" | ").slice(0, 500);
  return result;
}

/** True, wenn der Prop-Name eine Action-Property ist (ChatGPT: `xAction`). */
export function isActionProp(name: string): boolean {
  return name.endsWith("Action");
}

/** Action-Props eines Widgets einsammeln (in Deklarationsreihenfolge). */
export function collectActionProps(props: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!props) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(props)) {
    if (isActionProp(k) && typeof v === "string" && v.trim()) out.push([k, v]);
  }
  return out;
}

/**
 * Startwerte für den DIL-State aus dem Baum ziehen: Widgets mit `id`/`name` und
 * `defaultValue`/`value`/`checked`/`defaultChecked` setzen `state.<id>`.
 * Dadurch funktionieren `$`-Bindings wie `"data": "$appData.series[state.metric]"`
 * schon beim ersten Render, ohne dass der Nutzer erst klicken muss.
 */
export function seedDefaults(json: unknown): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  const seen = new Set<string>();
  let count = 0;
  const MAX_NODES = 5000;
  const MAX_DEPTH = 40;

  const walk = (node: unknown, depth: number): void => {
    if (++count > MAX_NODES || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (!isPlainObject(node)) return;
    const props = isPlainObject(node.props) ? node.props : {};
    const pick = (k: string): unknown => (k in props ? props[k] : k in node ? node[k] : undefined);
    const rawId = pick("id") ?? pick("name");
    if (typeof rawId === "string" && isSafePath(rawId) && !seen.has(rawId)) {
      const v = pick("defaultValue") ?? pick("value") ?? pick("defaultChecked") ?? pick("checked");
      // Dynamische Werte ($-CEL) sind keine Startwerte.
      if (v !== undefined && !(typeof v === "string" && v.trim().startsWith("$"))) {
        state[rawId] = v;
        seen.add(rawId);
      }
    }
    walk(node.children, depth + 1);
  };

  walk(json, 0);
  return state;
}
