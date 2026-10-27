// DIL — Dynamic Interactive Language (ChatGPT „interaktive Fenster" / GenUI).
// Nachbau des v1-Contracts aus /opt/chatgpt-re/docs/20-dil-contract.md.
// Rein und RN-unabhängig → ohne Expo in `node --experimental-strip-types --test` testbar.
//
// Zwei Formate (DILCompiler.compileJsonValue):
//   v1 = deklarativer Widget-Baum   { type, props, children } + Text-Strings
//   v2 = vom Modell generierter JS-Code { code | compiledDil } → läuft in QuickJS-Sandbox
//
// Dieses Modul implementiert v1 vollständig (Parser, CEL-Bindung, Kontrollfluss,
// Widget-Schema-Katalog) und *erkennt* v2 (Sandbox-Ausführung folgt separat).

// ───────────────────────────── Typen ─────────────────────────────

export type DilText = string;

export type DilProps = Record<string, unknown>;

export interface DilObject {
  type: string;
  props?: DilProps;
  children?: DilNode[];
  id?: string;
  key?: string;
  [k: string]: unknown; // flache Props sind ebenfalls erlaubt (function j(e,r))
}

export type DilNode = DilText | DilObject;

/** DIL v2 — Wurzel mit vom Modell generierter Render-Funktion. */
export interface DilV2Root {
  kind: "v2";
  code?: string;
  compiledDil?: string;
  appData?: unknown;
  constants?: Record<string, unknown>;
  clientDefinedWidgets?: unknown[];
  requiredComponents?: unknown[];
}

export type ParsedDil = DilNode | DilV2Root;

/** Normalisierter, renderbarer Baum (Kontrollfluss aufgelöst, Props gebunden). */
export type ResolvedNode =
  | { kind: "text"; text: string }
  | { kind: "widget"; type: string; props: DilProps; children: ResolvedNode[] };

// ───────────────────────────── Widget-Schema-Katalog ─────────────────────────────
// Quelle: dil_widgets.dec → dilV2Properties (docs/20-dil-contract.md §5).
// Dient als (a) Referenz, (b) Validierung unbekannter Widgets, (c) Auto-Doku.

const STACK_PROPS = [
  "gap", "padding", "align", "justify", "direction", "wrap",
  "flex", "grow", "shrink", "width", "height", "maxWidth", "maxHeight",
  "minWidth", "minHeight", "size", "background", "border", "radius", "clip",
  "position", "margin", "flush", "scrollable", "ariaHidden", "ariaLabel", "role",
];

const BOX_PROPS = [
  "align", "ariaHidden", "ariaLabel", "aspectMode", "aspectRatio", "background",
  "border", "clip", "direction", "disableAutoSpacing", "flex", "flush", "gap",
  "height", "justify", "maxHeight", "maxWidth", "minHeight", "minWidth",
  "padding", "radius", "role", "rowSpan", "scrollable", "span", "theme", "width", "wrap",
];

/** Widget → erlaubte Properties (dilV2Properties). `...STACK`/`...BOX` sind aufgelöst. */
export const WIDGET_PROPS: Record<string, string[]> = {
  YouTubeEmbed: ["aspectRatio", "maxWidth", "onPlayerError", "showThumbnail", "title", "videoId", "width"],
  Textarea: ["autoResize", "autoSelect", "defaultValue", "disabled", "invalid", "maxRows", "name", "onChange", "placeholder", "required", "rows", "size", "value", "variant"],
  Table: ["columnSizing", "columns", "dividers", "emptyLabel", "rows", "stickyHeader"],
  TableHeader: ["header", "label", "labelColSpan"],
  TableCell: ["align", "colSpan", "header", "padding", "rowSpan", "vAlign", "width"],
  Spacer: ["minSize"],
  Slider: ["defaultValue", "disabled", "label", "marks", "max", "min", "name", "onChange", "required", "sliderStyle", "step", "value"],
  Select: ["align", "ariaLabel", "block", "clearable", "defaultValue", "disabled", "dropdownIconType", "name", "onChange", "options", "pill", "placeholder", "required", "side", "size", "value", "variant"],
  SegmentedControl: ["block", "defaultValue", "disabled", "label", "onChange", "options", "pill", "size", "value", "variant"],
  Image: ["alt", "aspectRatio", "containOutsideAspectRatio", "fallback", "fit", "frame", "height", "hideOnFailure", "maxHeight", "maxWidth", "minHeight", "minWidth", "position", "radius", "size", "src", "width"],
  SearchImage: ["alt", "aspectRatio", "background", "bitmapBlendMode", "containOutsideAspectRatio", "contentCropFit", "fallback", "fit", "frame", "height", "hideOnFailure", "maxHeight", "maxWidth", "minHeight", "minWidth", "onError", "onLoad", "position", "preload", "radius", "searchImage", "upgradeToFullRes", "width"],
  Row: [...STACK_PROPS, "rowGap"],
  Col: [...STACK_PROPS, "rowGap"],
  RadioGroup: ["defaultValue", "direction", "disabled", "label", "name", "onChange", "options", "required", "value"],
  Radio: ["disabled", "id", "required", "value"],
  PulseIndicator: ["color", "duration", "endScale", "pulseColor", "size", "startOpacity"],
  Pressable: ["block", "onClick", ...STACK_PROPS, "capture", "ariaPressed", "disabled", "dimWhenDisabled", "inline", "selectable", "tooltip", "variant", "hoverBackground", "variantFeedback"],
  Svg: ["aria-hidden", "aria-label", "color", "fill", "height", "preserveAspectRatio", "role", "size", "stroke", "strokeLinecap", "strokeLinejoin", "strokeWidth", "viewBox", "width", "xmlns"],
  AnimatedSvg: ["advanceRate", "alt", "animationEndTime", "animationStartTime", "aspectRatio", "currentTime", "fit", "height", "loop", "maxHeight", "maxWidth", "minHeight", "minWidth", "radius", "src", "width"],
  Lottie: ["advanceRate", "alt", "animationEndTime", "animationStartTime", "aspectRatio", "currentTime", "fit", "height", "loop", "maxHeight", "maxWidth", "minHeight", "minWidth", "radius", "src", "width"],
  Icon: ["color", "size", "name", "weight"],
  LoadingDot: ["label", "size"],
  LoadingBlock: ["background", "duration", "height", "label", "maxHeight", "maxSize", "maxWidth", "minHeight", "minSize", "minWidth", "radius", "size", "width"],
  List: ["connector", "gap", "items", "marker", "maxMarkerSize", "ordered", "start"],
  ListItem: ["checked", "description", "disabled", "label", "marker", "markerSize"],
  Input: ["autoSelect", "defaultValue", "disabled", "fontSize", "inputType", "invalid", "mask", "name", "onChange", "pill", "placeholder", "required", "size", "value", "variant"],
  HorizontalSwipeSurface: ["captureAllDrags", "disabled", "dismissDirection", "onDrag", "onSwipeLeft", "onSwipeRight", "reducedMotion", "rotateWhileDragging"],
  GridItem: [...BOX_PROPS, "span", "rowSpan"],
  Grid: ["columnGap", "columns", "gap", "minChildWidth", "rowGap", "rows"],
  Form: [...STACK_PROPS, "onSubmit"],
  Box: [...BOX_PROPS],
  Flow: ["columns", "gap", "layout", "rows"],
  Favicon: ["alt", "frame", "inline", "size", "url"],
  Divider: ["color", "flush", "size", "spacing"],
  DatePicker: ["align", "block", "clearable", "defaultValue", "disabled", "max", "min", "onChange", "pill", "placeholder", "required", "side", "size", "value", "variant"],
  FlowItem: [...STACK_PROPS, "columnGap"],
  WebWidget: [...BOX_PROPS, "bind", "fallback", "invocationId"],
  ClientDefinedWidget: [...BOX_PROPS, "bind", "fallback", "invocationId"],
  Checkbox: ["checked", "defaultChecked", "disabled", "label", "lineThrough", "name", "onChange", "required", "shape", "value"],
  Tooltip: ["trigger", "reducedMotion"],
  Card: ["background", "disableAutoSpacing", "gap", "height", "justify", "onVisible", "onVisibleWhen", "padding", "radius", "selectable", "shadow", "size", "theme", "variant", "width"],
  Button: ["block", "color", "disabled", "label", "loading", "onClick", "pill", "size", "submit", "truncate", "uniform", "variant"],
  OverflowRow: [...STACK_PROPS, "columnGap", "onVisible", "onVisibleKey", "onVisibleWhen", "rowGap"],
  VideoCarouselItem: ["media", "size"],
  Carousel: ["activeIndex", "ariaLabel", "flush", "gap", "onChange", "showArrows", "snap", "snapAlign", "visibleItems"],
  VideoCarousel: ["activeIndex", "ariaLabel", "flush", "gap", "onChange", "showArrows", "snap", "snapAlign", "visibleItems"],
  Badge: ["color", "label", "maxWidth", "onHover", "padding", "pill", "size", "variant", "weight"],
  Popover: ["hoverOpenDelay", "open", "showOnHover", "align", "side", "sideOffset", "showCloseButton"],
  FlashcardFlip: ["activeKey", "disabled", "dismissDirection", "flipped", "isMobile", "onInteractionChange", "onSwipeLeft", "onSwipeProgress", "onSwipeRight", "reducedMotion", "restoreDirection", "shuffleKey"],
  FlashcardFlipStack: ["activeKey", "flipped", "reducedMotion", "onInteractionChange"],
  // Charts (dil_charts.dec)
  PieChart: ["aspectRatio", "flex", "height", "maxHeight", "maxSize", "maxWidth", "minHeight", "minSize", "minWidth", "size", "width", "cornerRadius", "data", "disableAnimation", "endAngle", "innerRadius", "minAngle", "legendMaxRows", "outerRadius", "paddingAngle", "series", "showLabelLines", "showLegend", "showTooltip", "showValueLabels", "startAngle", "tooltipAllowEscapeViewBox", "tooltipAnimationDuration", "tooltipOffset", "tooltipValueFormatter", "tooltipValueMode", "xAxis"],
  ValdiPieChart: ["aspectRatio", "flex", "height", "maxHeight", "maxSize", "maxWidth", "minHeight", "minSize", "minWidth", "size", "width", "cornerRadius", "data", "disableAnimation", "endAngle", "innerRadius", "minAngle", "legendMaxRows", "outerRadius", "paddingAngle", "series", "showLabelLines", "showLegend", "showTooltip", "showValueLabels", "startAngle", "tooltipAllowEscapeViewBox", "tooltipAnimationDuration", "tooltipOffset", "tooltipValueFormatter", "tooltipValueMode", "xAxis"],
  Chart: ["aspectRatio", "flex", "height", "maxHeight", "maxSize", "maxWidth", "minHeight", "minSize", "minWidth", "size", "width", "barCategoryGap", "barGap", "barRadius", "data", "disableAnimation", "disableUserScroll", "enableLegendSeriesToggle", "hoverIndicatorDataKey", "layout", "legendMaxRows", "maxBarSize", "maxTooltipEntries", "minPointWidth", "onHover", "scrollable", "scrollToValue", "series", "showDots", "showGrid", "showHoverCursor", "showHoverDots", "showIdleHoverIndicator", "showLegend", "showTooltip", "showTooltipCursor", "showTooltipLabel", "showTooltipMarkers", "showValueLabels", "showYAxis", "tooltipAllowEscapeViewBox", "tooltipAnimationDuration", "tooltipOffset", "tooltipValueFormatter", "tooltipValueMode", "xAxis"],
  ValdiChart: ["aspectRatio", "flex", "height", "maxHeight", "maxSize", "maxWidth", "minHeight", "minSize", "minWidth", "size", "width", "barCategoryGap", "barGap", "barRadius", "data", "disableAnimation", "disableUserScroll", "enableLegendSeriesToggle", "hoverIndicatorDataKey", "layout", "legendMaxRows", "maxBarSize", "maxTooltipEntries", "minPointWidth", "onHover", "scrollable", "scrollToValue", "series", "showDots", "showGrid", "showHoverCursor", "showHoverDots", "showIdleHoverIndicator", "showLegend", "showTooltip", "showTooltipCursor", "showTooltipLabel", "showTooltipMarkers", "showValueLabels", "showYAxis", "tooltipAllowEscapeViewBox", "tooltipAnimationDuration", "tooltipOffset", "tooltipValueFormatter", "tooltipValueMode", "xAxis"],
  // Text/Math (dil_text.dec)
  Text: ["block", "value"],
  Markdown: ["streaming", "value", "fontSize", "lineHeight", "textAlign"],
  Math: ["streaming", "value"],
};

/** Gemeinsame Layout-Properties, die jedes Widget (implizit) akzeptieren darf. */
export const COMMON_PROPS = ["id", "key", "gap", "$gap", "flex", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "padding", "margin", "background", "border", "radius", "clip", "align", "justify", "direction", "scrollable", "ariaLabel", "ariaHidden", "role"];

/** Kontrollfluss-Widgets (intrinsisch, nicht über WIDGET_PROPS registriert). */
export const CONTROL_FLOW_WIDGETS = new Set(["Show", "ShowElse", "Scope", "Each"]);

/** True, wenn das Widget im Katalog (oder intrinsisch) bekannt ist. */
export function isKnownWidget(type: string): boolean {
  return CONTROL_FLOW_WIDGETS.has(type) || Object.prototype.hasOwnProperty.call(WIDGET_PROPS, type);
}

// ───────────────────────────── Parser ─────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse einen beliebigen JSON-Wert in einen DIL-Knoten (v1) bzw. v2-Root. */
export function parseDil(json: unknown): ParsedDil {
  if (typeof json === "string") return json as DilText;
  if (!isPlainObject(json)) {
    // Zahlen/Bools/null → als Text darstellen (Defensive, kein Crash)
    return json == null ? "" : String(json);
  }
  const root = json as Record<string, unknown>;
  if (typeof root.code === "string" || typeof root.compiledDil === "string") {
    return {
      kind: "v2",
      code: typeof root.code === "string" ? root.code : undefined,
      compiledDil: typeof root.compiledDil === "string" ? root.compiledDil : undefined,
      appData: root.appData,
      constants: isPlainObject(root.constants) ? root.constants : undefined,
      clientDefinedWidgets: Array.isArray(root.clientDefinedWidgets) ? root.clientDefinedWidgets : undefined,
      requiredComponents: Array.isArray(root.requiredComponents) ? root.requiredComponents : undefined,
    };
  }
  const type = typeof root.type === "string" ? root.type : "Unknown";
  const children = Array.isArray(root.children) ? root.children : undefined;
  const node: DilObject = { type };
  if (children) node.children = children;
  // props-Block
  if (isPlainObject(root.props)) node.props = root.props as DilProps;
  if (typeof root.id === "string") node.id = root.id;
  if (typeof root.key === "string") node.key = root.key;
  // flache Props (alles außer reservierten Keys) übernehmen
  for (const k of Object.keys(root)) {
    if (k === "type" || k === "props" || k === "children" || k === "id" || k === "key") continue;
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue; // Pollution-Schutz
    (node as Record<string, unknown>)[k] = root[k];
  }
  return node;
}

// ───────────────────────────── Mini-CEL (Datenbindung) ─────────────────────────────
// DILPropertiesSchema: `$gap` = dynamischer CEL-Ausdruck, `gap` = statisch,
// `gapAction` = Sandbox-Callback. Wir evaluieren CEL selbst (kein eval()).

export class DilCelError extends Error {
  expression: string;
  constructor(expression: string, message: string) {
    super(`CEL "${expression}": ${message}`);
    this.expression = expression;
  }
}

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "eof"; v: "" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
      const raw = src.slice(i, j);
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new DilCelError(src, `ungültige Zahl "${raw}"`);
      toks.push({ t: "num", v });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== q) {
        if (src[j] === "\\" && j + 1 < n) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      if (j >= n) throw new DilCelError(src, "unterminiertes String-Literal");
      toks.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === "true") toks.push({ t: "num", v: 1 });
      else if (word === "false") toks.push({ t: "num", v: 0 });
      else if (word === "null") toks.push({ t: "ident", v: "null" });
      else toks.push({ t: "ident", v: word });
      i = j;
      continue;
    }
    // Operatoren (längste zuerst)
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%<>!?:.()[]".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new DilCelError(src, `unerwartetes Zeichen "${c}"`);
  }
  toks.push({ t: "eof", v: "" });
  return toks;
}

class CelParser {
  toks: Tok[];
  pos = 0;
  src: string;
  scope: Record<string, unknown> = {};
  depth = 0;
  constructor(src: string) {
    this.src = src;
    this.toks = tokenize(src);
  }
  peek(): Tok { return this.toks[this.pos]; }
  next(): Tok { return this.toks[this.pos++]; }
  expectOp(v: string): void {
    const t = this.peek();
    if (t.t !== "op" || t.v !== v) throw new DilCelError(this.src, `erwartet "${v}"`);
    this.pos++;
  }

  parse(): unknown {
    const v = this.parseTernary();
    if (this.peek().t !== "eof") throw new DilCelError(this.src, "unerwartetes Token am Ende");
    return v;
  }

  parseTernary(): unknown {
    const cond = this.parseOr();
    if (this.peek().t === "op" && this.peek().v === "?") {
      this.pos++;
      const a = this.parseTernary();
      this.expectOp(":");
      const b = this.parseTernary();
      return cond ? a : b;
    }
    return cond;
  }

  parseOr(): unknown {
    let left = this.parseAnd();
    while (this.peek().t === "op" && this.peek().v === "||") {
      this.pos++;
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  parseAnd(): unknown {
    let left = this.parseCmp();
    while (this.peek().t === "op" && this.peek().v === "&&") {
      this.pos++;
      const right = this.parseCmp();
      left = left && right;
    }
    return left;
  }

  parseCmp(): unknown {
    let left = this.parseAdd();
    while (this.peek().t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(this.peek().v as string)) {
      const op = this.next().v;
      const right = this.parseAdd();
      switch (op) {
        case "==": left = left === right; break;
        case "!=": left = left !== right; break;
        case "<": left = (left as number) < (right as number); break;
        case "<=": left = (left as number) <= (right as number); break;
        case ">": left = (left as number) > (right as number); break;
        case ">=": left = (left as number) >= (right as number); break;
      }
    }
    return left;
  }

  parseAdd(): unknown {
    let left = this.parseMul();
    while (this.peek().t === "op" && (this.peek().v === "+" || this.peek().v === "-")) {
      const op = this.next().v;
      const right = this.parseMul();
      if (op === "+") left = (left as number) + (right as number);
      else left = (left as number) - (right as number);
    }
    return left;
  }

  parseMul(): unknown {
    let left = this.parseUnary();
    while (this.peek().t === "op" && ["*", "/", "%"].includes(this.peek().v as string)) {
      const op = this.next().v;
      const right = this.parseUnary();
      if (op === "*") left = (left as number) * (right as number);
      else if (op === "/") left = (left as number) / (right as number);
      else left = (left as number) % (right as number);
    }
    return left;
  }

  parseUnary(): unknown {
    if (this.peek().t === "op" && (this.peek().v === "!" || this.peek().v === "-" || this.peek().v === "+")) {
      const op = this.next().v;
      const v = this.parseUnary();
      if (op === "!") return !v;
      if (op === "-") return -(v as number);
      return v;
    }
    return this.parsePrimary();
  }

  parsePrimary(): unknown {
    const t = this.peek();
    if (t.t === "num") { this.pos++; return t.v; }
    if (t.t === "str") { this.pos++; return t.v; }
    if (t.t === "op" && t.v === "(") {
      this.depth++;
      if (this.depth > 64) throw new DilCelError(this.src, "zu tief verschachtelt (max 64)");
      this.pos++;
      const v = this.parseTernary();
      this.expectOp(")");
      this.depth--;
      return v;
    }
    if (t.t === "ident") {
      return this.parsePath();
    }
    throw new DilCelError(this.src, "unerwartetes Token");
  }

  parsePath(): unknown {
    const first = this.next(); // ident
    let path = String(first.v);
    // Führendes `$` = Scope-Zugriff (CEL-Konvention): `$products` → scope["products"].
    if (path.startsWith("$")) path = path.slice(1);
    const scope = this.scope;
    while (this.peek().t === "op" && (this.peek().v === "." || this.peek().v === "[")) {
      if (this.peek().v === ".") {
        this.pos++;
        const seg = this.next();
        if (seg.t !== "ident") throw new DilCelError(this.src, "erwartet Property nach '.'");
        path += "." + seg.v;
      } else {
        this.pos++; // [
        this.depth++;
        if (this.depth > 64) throw new DilCelError(this.src, "zu tief verschachtelt (max 64)");
        const idx = this.parseTernary();
        this.expectOp("]");
        this.depth--;
        path += "[" + String(idx) + "]";
      }
    }
    return resolveValueAtPath(scope, path);
  }
}

/** Wert an einem Pfad auflösen: `item.name`, `state.count`, `list[0]`. */
export function resolveValueAtPath(scope: unknown, path: string): unknown {
  const segs: string[] = [];
  let cur = "";
  let inBracket = false;
  for (const ch of path) {
    if (ch === ".") { if (!inBracket) { if (cur) segs.push(cur); cur = ""; continue; } }
    if (ch === "[") { if (cur) { segs.push(cur); cur = ""; } inBracket = true; continue; }
    if (ch === "]") { if (cur) { segs.push(cur); cur = ""; } inBracket = false; continue; }
    cur += ch;
  }
  if (cur) segs.push(cur);

  let val: unknown = scope;
  for (const seg of segs) {
    if (seg === "") continue;
    if (val == null) return undefined;
    if (typeof val === "object" || typeof val === "function") {
      const rec = val as Record<string, unknown>;
      const num = /^\d+$/.test(seg) ? Number(seg) : undefined;
      if (Array.isArray(val)) {
        val = num !== undefined ? val[num] : undefined;
      } else {
        val = Object.prototype.hasOwnProperty.call(rec, seg) ? rec[seg] : undefined;
      }
    } else {
      return undefined;
    }
  }
  return val;
}

/** CEL-Ausdruck gegen einen Scope evaluieren (sicherer Mini-Evaluator). */
export function evalCel(expression: string, scope: Record<string, unknown> = {}): unknown {
  if (expression.length > 1000) throw new DilCelError(expression, "Ausdruck zu lang (max 1000 Zeichen)");
  const parser = new CelParser(expression);
  parser.scope = scope;
  return parser.parse();
}

/** Property auflösen: `$name` → CEL, `name` → statisch, `nameAction` → Callback-Referenz. */
export function resolveProp(name: string, raw: unknown, scope: Record<string, unknown>): unknown {
  if (name.startsWith("$")) {
    if (typeof raw !== "string") return raw;
    try {
      return evalCel(raw, scope);
    } catch (e) {
      // Defekter CEL-Ausdruck (LLM-generiert möglich) → rohen Text zeigen statt den ganzen Block zu killen.
      if (e instanceof DilCelError) return raw;
      throw e;
    }
  }
  if (name.endsWith("Action")) {
    // Callback läuft in der Sandbox; hier nur die Referenz durchreichen.
    return raw;
  }
  return raw;
}

// ───────────────────────────── Kontrollfluss + Auflösung ─────────────────────────────

function truthy(v: unknown): boolean {
  return !!v;
}

function isDilObject(n: DilNode): n is DilObject {
  return typeof n === "object" && n !== null;
}

/**
 * v1-Baum in einen renderbaren Baum überführen:
 * - `Show`/`ShowElse` konditional
 * - `Scope` erweitert den CEL-Scope
 * - `Each` iteriert
 * - `$prop`-Bindungen werden gegen den Scope evaluiert
 */
export function resolveDil(node: DilNode, scope: Record<string, unknown> = {}, depth = 0, ctx: ResolveCtx = { count: 0 }): ResolvedNode[] {
  const out: ResolvedNode[] = [];
  if (depth > 64 || ctx.count >= MAX_RESOLVED_NODES) return out; // DoS-Schutz (Tiefe + Knoten-Budget)
  const root = parseDil(node) as DilNode; // normalisieren (falls rohes JSON reinkam)

  if (typeof root === "string") {
    ctx.count++;
    out.push({ kind: "text", text: root });
    return out;
  }
  if (!isDilObject(root)) return out;

  const type = root.type;

  // Show konsumiert seine ShowElse-Kinder (if/else-Semantik aus dem Contract).
  if (type === "Show") {
    let when = root.when ?? root.visible;
    if (when === undefined) when = root.$when ?? root.$visible;
    if (typeof when === "string") {
      try { when = evalCel(when, scope); } catch { when = true; } // defekter Ausdruck → Inhalt zeigen (fail-open)
    }
    const show = when === undefined ? true : truthy(when);
    const children = root.children ?? [];
    if (show) {
      const branch = children.filter((c) => !(isDilObject(c) && c.type === "ShowElse"));
      return resolveDilList(branch, scope, depth + 1, ctx);
    }
    // else-Zweig: Kinder der ShowElse-Knoten entpacken und rendern (nicht das ShowElse-Widget selbst).
    const elseChildren: DilNode[] = [];
    for (const c of children) {
      if (isDilObject(c) && c.type === "ShowElse") elseChildren.push(...(c.children ?? []));
    }
    return resolveDilList(elseChildren, scope, depth + 1, ctx);
  }

  // ShowElse ist nur als Kind von Show gültig; alleinstehend → leer (defensiv).
  if (type === "ShowElse") return out;

  if (type === "Scope") {
    const values = isPlainObject(root.values) ? (root.values as Record<string, unknown>) : {};
    const nextScope: Record<string, unknown> = { ...scope, ...values };
    return resolveDilList(root.children ?? [], nextScope, depth + 1, ctx);
  }

  if (type === "Each") {
    const itemsRaw = root.of ?? root.items;
    let items: unknown = typeof itemsRaw === "string" ? undefined : itemsRaw;
    if (items === undefined) {
      try { items = evalCel(itemsRaw as string, scope); } catch { items = []; }
    }
    if (!Array.isArray(items)) return out;
    const itemName = (root.itemName ?? root.item ?? "item") as string;
    const indexName = (root.indexName ?? root.index ?? "index") as string;
    const cap = Math.min(items.length, 500); // Cap gegen DoS (Riesen-Array)
    for (let index = 0; index < cap; index++) {
      if (++ctx.count > MAX_RESOLVED_NODES) break; // JEDE Iteration zählt gegen das Budget (auch bei leeren children)
      const nextScope: Record<string, unknown> = { ...scope, [itemName]: items[index], [indexName]: index };
      out.push(...resolveDilList(root.children ?? [], nextScope, depth + 1, ctx));
    }
    return out;
  }

  // Normales Widget
  const rawProps = collectProps(root);
  const props: DilProps = {};
  for (const [k, v] of Object.entries(rawProps)) {
    props[k] = resolveProp(k, v, scope);
  }
  const children = resolveDilList(root.children ?? [], scope, depth + 1, ctx);
  ctx.count++;
  out.push({ kind: "widget", type, props, children });
  return out;
}

function resolveDilList(nodes: DilNode[], scope: Record<string, unknown>, depth: number, ctx: ResolveCtx): ResolvedNode[] {
  const out: ResolvedNode[] = [];
  for (const n of nodes) {
    if (ctx.count >= MAX_RESOLVED_NODES) break;
    out.push(...resolveDil(n, scope, depth, ctx));
  }
  return out;
}

/** Props eines Knotens einsammeln: props-Block + flache Props (außer reservierte Keys). */
function collectProps(node: DilObject): DilProps {
  const out: DilProps = {};
  const add = (k: string, v: unknown) => {
    // Prototype-Pollution-Härtung: gefährliche Keys verwerfen.
    if (k === "__proto__" || k === "constructor" || k === "prototype") return;
    out[k] = v;
  };
  if (isPlainObject(node.props)) for (const [k, v] of Object.entries(node.props)) add(k, v);
  for (const k of Object.keys(node)) {
    if (k === "type" || k === "props" || k === "children" || k === "id" || k === "key") continue;
    add(k, node[k]);
  }
  return out;
}

// ───────────────────────────── DIL-Erkennung im Text ─────────────────────────────
// pi liefert interaktive Antworten als Markdown-Fence ```dil …``` (JSON).
// Diese Funktion zerlegt einen Antworttext in Markdown- und DIL-Blöcke, damit die
// App Widgets statt Text rendern kann. Pure Funktion, ohne RN.

export type DilBlock =
  | { kind: "md"; text: string }
  | { kind: "dil"; json: unknown; raw: string; parseError?: string };

/**
 * Antworttext in Markdown- und DIL-Blöcke zerlegen.
 * ```dil …``` (und ```dil\n…```) wird als DIL-Block erkannt; kaputtes JSON
 * bleibt als Block erhalten (parseError gesetzt), damit der Renderer einen
 * sauberen Fallback zeigen kann statt zu crashen.
 */
export function splitDilBlocks(text: string): DilBlock[] {
  const out: DilBlock[] = [];
  if (!text) return out;
  const re = /```dil\b[^\n]*\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index);
    if (before) out.push({ kind: "md", text: before });
    const raw = m[1].trim();
    let json: unknown = null;
    let parseError: string | undefined;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
    out.push({ kind: "dil", json, raw, parseError });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  if (rest) out.push({ kind: "md", text: rest });
  return out;
}

/** Budget-Zähler gegen exponentielle Knoten-Explosion (verschachteltes `Each`). */
type ResolveCtx = { count: number };
const MAX_RESOLVED_NODES = 10_000;

/** Schema-Allowlist für Bild-URLs (verhindert Client-SSRF/Tracking via file://, http://, Loopback/private Hosts). */
const BLOCKED_IMAGE_HOST = /^https:\/\/(localhost(\/|:|$)|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?(\/|:|$))/i;
const BLOCKED_HOSTNAME = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?)$/i;

export function isSafeImageSrc(src: string): boolean {
  if (src.length > 50_000) return false; // Base64-/Riesen-Payload-Cap
  if (/^https:\/\//i.test(src)) {
    if (BLOCKED_IMAGE_HOST.test(src)) return false; // schneller String-Check (wie bisher)
    try {
      const u = new URL(src);
      // userinfo-Trick (https://x@127.0.0.1/) + Hostname-Block (inkl. DNS-Rebinding-artiger Hosts) blocken.
      if (u.username || u.password) return false;
      if (BLOCKED_HOSTNAME.test(u.hostname)) return false;
    } catch {
      return false; // unparsbare URL → nicht vertrauenswürdig
    }
    return true;
  }
  return /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(src.slice(0, 64));
}

/** Eine DIL-Antwort (JSON-Wert) vollständig auflösen. */
export function resolveDilRoot(json: unknown, scope: Record<string, unknown> = {}): ResolvedNode[] {
  const parsed = parseDil(json);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "kind" in parsed && (parsed as DilV2Root).kind === "v2") {
    const v2 = parsed as DilV2Root;
    // v2: `code`/`compiledDil` sind vom Modell generierte JS-Render-Funktionen, die in der
    // QuickJS-Sandbox laufen. Wir führen KEINEN Fremdcode aus (kein eval/Function-Konstruktor
    // — Sicherheitshärtung). Stattdessen:
    //   (1) appData als deklarativen Baum rendern, falls es Widget-Struktur trägt,
    //   (2) constants als CEL-Scope für appData-Referenzen ($x) bereitstellen,
    //   (3) sonst ein sauberer Fallback.
    const data = v2.appData;
    if (data != null && (Array.isArray(data) || (typeof data === "object"))) {
      const mergedScope: Record<string, unknown> = { ...scope, ...(v2.constants ?? {}) };
      const dataNodes = resolveDil(data as DilNode, mergedScope);
      if (dataNodes.length) return dataNodes;
    }
    return [{ kind: "widget", type: "ClientDefinedWidget", props: { fallback: "Interaktive Ansicht (Sandbox nicht verfügbar)", constants: v2.constants }, children: [] }];
  }
  return resolveDil(parsed as DilNode, scope);
}

/** True, wenn die Antwort eine v2-Root (code/compiledDil) ist. */
export function isDilV2(json: unknown): boolean {
  const parsed = parseDil(json);
  return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && "kind" in parsed && (parsed as DilV2Root).kind === "v2";
}
