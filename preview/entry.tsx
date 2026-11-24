import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { Dil, DilBereich, DilRichText } from "../Dil.tsx";

const b1 = { type: "Slider", props: { label: "Menge (App-Pfad)", id: "menge", min: 0, max: 10, step: 1, defaultValue: 2 } };
const b2 = { type: "Chart", props: { type: "bar", data: [{ label: "x1", $value: "state.menge * 10" }, { label: "x2", value: 20 }] } };
const b4 = { type: "StatGrid", props: { columns: 3, items: [
  { label: "Bier/Woche", $value: "state.menge", unit: "Stk" },
  { label: "Pro Jahr", $value: "state.menge * 52" },
  { label: "Kosten 10 J", $value: "state.menge * 52 * 10 * 3.5", delta: 12 },
] } };
const z1 = { type: "Col", props: { gap: 10 }, children: [
  { type: "Slider", props: { label: "Startkapital", id: "start", min: 1000, max: 20000, step: 500, defaultValue: 10000 } },
  { type: "Slider", props: { label: "Zins", id: "zins", min: 0, max: 10, step: 0.5, defaultValue: 5 } },
  { type: "Slider", props: { label: "Jahre", id: "jahre", min: 1, max: 40, step: 1, defaultValue: 10 } },
] };
const z2 = { type: "StatGrid", props: { columns: 3, items: [
  { label: "Endkapital", $value: "round(state.start * (1 + state.zins/100) ^ state.jahre, 0)", unit: "EUR" },
  { label: "Gewinn", $value: "round(state.start * (1 + state.zins/100) ^ state.jahre - state.start, 0)", unit: "EUR" },
  { label: "Verdopplung nach", $value: "round(72 / max(state.zins, 0.1), 1)", unit: "J" },
] } };
import { setImageBaseUrl } from "../lib";
import umlBlock from "./uml.json";
setImageBaseUrl("http://127.0.0.1:8099");
const b3 = { type: "Table", props: { columns: ["KPI", "Wert"], rows: [["Basis", { "$value": "state.menge" }], ["Pro Jahr", { "$value": "state.menge * 52" }], ["Kosten", { "$value": "state.menge * 52 * 3.5" }]] } };
const dil = (o: unknown) => "```dil\n" + JSON.stringify(o) + "\n```";

const demo = [
  dil({ type: "Form", props: { gap: 12 }, children: [
    { type: "Slider", props: { label: "Bier pro Woche", id: "bier", min: 0, max: 21, step: 1, defaultValue: 5, required: true, marks: [0, 5, 10, 15, 21] } },
    { type: "Slider", props: { label: "Trinkjahre (gesperrt)", id: "jahre", min: 0, max: 60, step: 5, defaultValue: 40, disabled: true } },
    { type: "Select", props: { label: "Kennzahl", id: "kennzahl", defaultValue: "pro Jahr", options: ["pro Woche", "pro Jahr", "gesamt"] } },
    { type: "Checkbox", props: { label: "Kosten zeigen", id: "kosten", defaultChecked: true } },
    { type: "RadioGroup", props: { label: "Getränk", id: "art", options: ["Bier", "Wein", "Schnaps"] } },
  ] }),
  dil({ type: "Chart", props: { type: "bar", data: [
    { label: "10 J", $value: "state.bier * 52 * 10" },
    { label: "20 J", $value: "state.bier * 52 * 20" },
    { label: "30 J", $value: "state.bier * 52 * 30" },
    { label: "40 J", $value: "state.bier * 52 * 40" },
  ] } }),
  dil({ type: "Table", props: { columns: ["Größe", "Wert"], rows: [
    ["Bier/Woche", { $value: "state.bier" }],
    ["Gesamt", { $value: "state.bier * 52 * state.jahre" }],
    ["Kosten €", { $value: "state.bier * 52 * state.jahre * 3.5" }],
    ["Gewählt", { $value: "state.kennzahl" }],
  ] } }),
  dil({ type: "PieChart", props: { data: [
    { label: "Bier (l)", $value: "state.bier * 52 * state.jahre * 0.5" },
    { label: "Sonstiges (l)", $value: "state.jahre * 365 * 2" },
  ] } }),
].join("\n\n");

createRoot(document.getElementById("root")!).render(
  <View style={{ padding: 16, backgroundColor: "#fff" }}>
    <DilRichText text={demo} />
    {/* App-Pfad: getrennte item.dil-Bloecke unter einem DilBereich */}
    <DilBereich jsons={[b1, b2, b3]} onAction={() => {}}>
      <View style={{ gap: 8 }}>
        <Dil json={b1} />
        <Dil json={b2} />
        <Dil json={b4} />
        <Dil json={b3} />
      </View>
    </DilBereich>
    <Dil json={umlBlock as any} />
    <Dil json={{ type: "Badge", props: { label: "UML-DEBUG-BADGE" } } as any} />
    {/* Zweites, unabhaengiges Szenario: Zinseszins (Potenz + round) */}
    <DilBereich jsons={[z1, z2]} onAction={() => {}}>
      <View style={{ gap: 8 }}>
        <Dil json={z1} />
        <Dil json={z2} />
      </View>
    </DilBereich>
  </View>,
);
