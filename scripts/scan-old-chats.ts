// Scannt alle Server-Sessions durch die ECHTE Client-Render-Pipeline (reine Funktionen)
// und meldet Ausnahmen / Ausreisser (Knoten, Textlaenge). Nur Analyse, keine Aenderung.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { splitDilBlocks, resolveDilRoot } from "../dil.ts";
import { normalizeChart, computePieSlices, classifyDiff } from "../dilviz.ts";
import { createRuntime, seedDefaults, collectActionProps, runtimeScope } from "../dilstate.ts";
import { sanitizeLoadedMessages, collapseTurnBubbles } from "../lib.ts";

const DIR = "/opt/kitty/server/data/sessions";
const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl") && !f.includes(".pruned"));

type Msg = { id?: string; role?: string; text: string; images?: unknown };
function loadMessages(file: string): Msg[] {
  const out: Msg[] = [];
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.type !== "message") continue;
    const m = o.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const parts = Array.isArray(m.content) ? m.content : (typeof m.content === "string" ? [{ type: "text", text: m.content }] : []);
    const text = parts.filter((b: any) => b && b.type === "text").map((b: any) => b.text || "").join(" ");
    if (m.role === "assistant" && !text.trim()) continue;
    out.push({ id: o.id, role: m.role, text, images: m.images });
  }
  return out;
}

function walkCount(n: any, acc: { nodes: number; maxDepth: number; maxText: number }, d = 0): void {
  acc.nodes++; acc.maxDepth = Math.max(acc.maxDepth, d);
  if (typeof n === "string") { acc.maxText = Math.max(acc.maxText, n.length); return; }
  if (!n || typeof n !== "object") return;
  if (n.props) for (const v of Object.values(n.props)) if (typeof v === "string") acc.maxText = Math.max(acc.maxText, (v as string).length);
  for (const c of n.children || []) walkCount(c, acc, d + 1);
}

const problems: any[] = [];
const stats: any[] = [];
for (const f of files) {
  const file = join(DIR, f);
  let messages = loadMessages(file);
  const before = messages.length;
  messages = (collapseTurnBubbles(messages as any, { includeTools: true }) as any) || messages;
  const collapsed = messages;
  const longest = collapsed.reduce((a, m) => Math.max(a, m.text.length), 0);
  let dilBlocks = 0, nodes = 0, maxNodes = 0, maxDepth = 0, maxText = 0, parseErr = 0;
  for (const m of messages) {
    let blocks;
    try { blocks = splitDilBlocks(m.text); } catch (e) { problems.push({ f, id: m.id, stage: "split", err: String(e) }); continue; }
    for (const b of blocks) {
      if (b.kind !== "dil") continue;
      dilBlocks++;
      if (b.parseError) parseErr++;
      try {
        const rt = createRuntime((b.json as any)?.appData, (b.json as any)?.constants);
        const resolved = resolveDilRoot(b.json, runtimeScope(rt));
        seedDefaults(b.json);
        const acc = { nodes: 0, maxDepth: 0, maxText: 0 };
        for (const n of resolved) { walkCount(n, acc); collectActionProps((n as any)?.props); }
        nodes += acc.nodes; maxNodes = Math.max(maxNodes, acc.nodes); maxDepth = Math.max(maxDepth, acc.maxDepth); maxText = Math.max(maxText, acc.maxText);
        // Chart/Diff-Pfade
        for (const n of resolved as any[]) {
          const t = n?.props?.type || n?.type;
          if (t === "Chart") { normalizeChart(n.props?.data ?? n.props?.points); }
          if (t === "PieChart") { computePieSlices(normalizeChart(n.props?.data ?? n.props?.points)); }
          if (t === "Diff") { classifyDiff(String(n.props?.old ?? ""), String(n.props?.new ?? "")); }
        }
      } catch (e) {
        problems.push({ f, id: m.id, stage: "resolve", err: String(e), snippet: m.text.slice(0, 120) });
      }
    }
  }
  stats.push({ f: f.slice(0, 12), before, after: messages.length, longest, dilBlocks, nodes, maxNodes, maxDepth, maxText, parseErr });
}
stats.sort((a, b) => b.maxNodes - a.maxNodes);
console.log("FILE         msgs(after) longestText dilBlocks nodes maxNodes depth maxText parseErr");
for (const s of stats.slice(0, 12))
  console.log(`${s.f} ${String(s.after).padStart(6)} ${String(s.longest).padStart(9)} ${String(s.dilBlocks).padStart(7)} ${String(s.nodes).padStart(6)} ${String(s.maxNodes).padStart(7)} ${String(s.maxDepth).padStart(4)} ${String(s.maxText).padStart(7)} ${String(s.parseErr).padStart(5)}`);
console.log(`\nDateien: ${stats.length} | Probleme: ${problems.length}`);
for (const p of problems.slice(0, 15)) console.log("  !!", JSON.stringify(p).slice(0, 300));
