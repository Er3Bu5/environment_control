/* The zone map, drawn as the design mock draws it: a wall, the zone's units as numbered circles, and a mark for each
   sensor, device and virtual device. Marks are icons, never names, so nothing on the map runs into anything else; the
   list and a screen reader carry the names. A sensor is filled with its height's colour (a soil probe with the soil
   colour), a device is outlined in its class colour, and a virtual device is dashed. */
import { html, nothing, svg, type TemplateResult } from "lit";
import { type IconName, icon, iconPath } from "./icons";
import { type Item, type ItemKind, type Layout, type Level, LEVELS, type Spot, beyondWall, geom, planted, posText, spotsFor } from "./layout";

export const MARK = 36;
const LEVEL_COLOR: Record<Level, string> = { above: "var(--above)", in: "var(--in)", under: "var(--under)" };

/* Device classes, as the mock groups controls: what a device's role makes it, and how its mark looks. */
export const CLASS_LOOK: Record<string, { icon: IconName; c: string; label: string; types: string[] }> = {
  humidity: { icon: "drop", c: "var(--hum)", label: "Humidity", types: ["Dehumidifier", "Humidifier"] },
  temperature: { icon: "thermo", c: "var(--temp)", label: "Temperature", types: ["Air conditioner", "Heater"] },
  airflow: { icon: "fan", c: "var(--air)", label: "Airflow", types: ["Fan"] },
  lights: { icon: "sun", c: "var(--sun)", label: "Lights", types: ["Light"] },
};

export interface Look {
  icon: IconName;
  c: string;
  fill?: boolean;
  dash?: boolean;
}

export function look(s: Item): Look {
  const k = Object.values(CLASS_LOOK).find((x) => x.types.includes(s.type ?? ""));
  /* A virtual device looks like a real one of its type, dashed: a tank is a tank, anything else a cube. */
  if (s.kind === "virtual") return k ? { icon: k.icon, c: k.c, dash: true } : s.type === "Tank" ? { icon: "tank", c: "var(--hum)", dash: true } : { icon: "cube", c: "var(--muted)", dash: true };
  if (s.kind === "device") return k ? { icon: k.icon, c: k.c } : { icon: "plug", c: "var(--muted)" };
  if (s.kind === "soil") return { icon: "probe", c: "var(--soil)", fill: true };
  return { icon: "chip", c: s.level ? LEVEL_COLOR[s.level] : "var(--muted)", fill: true };
}

/* The same mark at text size, for lists and the key. */
export const mk = (k: Look) => html`<span class="mk ${k.fill ? "fill" : ""} ${k.dash ? "dash" : ""}" style="--c:${k.c}">${icon(k.icon)}</span>`;

export const keyView = html`<div class="key">
  <span><i class="unit"></i>Unit</span>
  ${(Object.keys(LEVELS) as Level[]).map((k) => html`<span>${mk({ icon: "chip", c: LEVEL_COLOR[k], fill: true })}Sensor, ${LEVELS[k].toLowerCase()}</span>`)}
  <span>${mk({ icon: "probe", c: "var(--soil)", fill: true })}Soil probe</span>
  ${Object.values(CLASS_LOOK).map((k) => html`<span>${mk({ icon: k.icon, c: k.c })}${k.label}</span>`)}
  <span>${mk({ icon: "plug", c: "var(--muted)" })}Unknown device type</span>
  <span>${mk({ icon: "cube", c: "var(--muted)", dash: true })}Virtual device, dashed</span>
  <span>${mk({ icon: "tank", c: "var(--hum)", dash: true })}Tank, virtual</span>
  <span><i class="wall"></i>Wall</span>
</div>`;

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

function baseMap(L: Layout, g: ReturnType<typeof geom>) {
  const aisles: TemplateResult[] = [], units: TemplateResult[] = [];
  for (let r = 0.5; r < L.rows - 0.5; r++)
    aisles.push(svg`<line x1=${g.wx} x2=${g.W - g.wx} y1=${g.Y(r)} y2=${g.Y(r)} stroke="var(--line)" stroke-dasharray="4 5"></line>`);
  for (let r = 0; r < L.rows; r++)
    for (let c = 0; c < L.cols; c++)
      if (planted(L, r, c))
        units.push(svg`<circle cx=${g.X(c)} cy=${g.Y(r)} r=${g.R} fill="var(--tile)" stroke="var(--off)"></circle><text x=${g.X(c)} y=${g.Y(r) + 5} text-anchor="middle" fill="var(--muted)" font-size="15">${r * L.cols + c + 1}</text>`);
  return svg`<rect x=${g.wx} y=${g.wy} width=${g.W - g.wx * 2} height=${g.H - g.wy * 2} rx="4" fill="none" stroke="var(--muted)" stroke-width="2"><title>Wall</title></rect>${aisles}${units}`;
}

function markView(s: Item, g: ReturnType<typeof geom>, offset: number, selected: boolean, onPick?: (id: string) => void, label?: string) {
  const [r, c] = s.pos as Spot, x = g.X(c), y = g.Y(r) + offset, k = look(s), h = MARK / 2;
  const ring = selected ? svg`<rect x=${x - h - 4} y=${y - h - 4} width=${MARK + 8} height=${MARK + 8} rx="10" fill="none" stroke="var(--fg)" stroke-width="2"></rect>` : nothing;
  const body = svg`<title>${s.name}</title>${ring}<rect x=${x - h} y=${y - h} width=${MARK} height=${MARK} rx="7" fill=${k.fill ? k.c : "var(--card)"} stroke=${k.c} stroke-width="2" stroke-dasharray=${k.dash ? "4 3" : "none"}></rect><svg x=${x - 11} y=${y - 11} width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d=${iconPath(k.icon)} fill=${k.fill ? "#FFFFFF" : k.c}></path></svg>`;
  if (!onPick) return svg`<g aria-label=${label ?? s.name} role="img">${body}</g>`;
  return svg`<g class="hit" role="button" tabindex="0" aria-label=${label ?? `Select ${s.name}`} @click=${() => onPick(s.id)} @keydown=${activate(() => onPick(s.id))}>${body}</g>`;
}

export interface MapOptions {
  items: Item[];
  picked?: string | null;
  /* Where the picked item may go: given, the map offers each free spot as a button. */
  placing?: Item | null;
  onSpot?: (p: Spot) => void;
  onPick?: (id: string) => void;
  /* Always draw the band outside the wall, so the map doesn't jump as the pick changes. */
  outer?: boolean;
  label: string;
}

export function mapView(L: Layout, o: MapOptions) {
  const placed = o.items.filter((s) => s.pos);
  const g = geom(L, !!o.outer || placed.some((s) => beyondWall(s.pos as Spot, L)));
  let spots: TemplateResult[] = [];
  if (o.placing && o.onSpot) {
    const onSpot = o.onSpot, kind: ItemKind = o.placing.kind;
    /* A unit takes any number of marks. Anywhere else holds one, so a spot already taken isn't offered. */
    const taken = (p: Spot) => placed.some((s) => s.id !== o.placing?.id && s.pos?.[0] === p[0] && s.pos?.[1] === p[1]);
    spots = spotsFor(kind, L)
      .filter((p) => planted(L, p[0], p[1]) || !taken(p))
      .map((p) => {
        const x = g.X(p[1]), y = g.Y(p[0]), go = () => onSpot(p), name = posText(p, L);
        return planted(L, p[0], p[1])
          ? svg`<g class="hit" role="button" tabindex="0" aria-label=${name} @click=${go} @keydown=${activate(go)}><circle cx=${x} cy=${y} r=${g.R} fill="transparent" stroke="var(--primary)" stroke-width="1.5"></circle></g>`
          : svg`<g class="hit" role="button" tabindex="0" aria-label=${name} @click=${go} @keydown=${activate(go)}><circle cx=${x} cy=${y} r="20" fill="transparent"></circle><path d=${`M${x - 7} ${y}h14M${x} ${y - 7}v14`} stroke="var(--primary)" stroke-width="2"></path></g>`;
      });
  }
  const seen: Record<string, number> = {};
  const marks = placed.map((s) => {
    const key = (s.pos as Spot).join(",");
    seen[key] = (seen[key] ?? 0) + 1;
    const where = posText(s.pos as Spot, L);
    return markView(s, g, (seen[key] - 1) * 40, o.picked === s.id, o.onPick, o.onPick ? `Select ${s.name}, ${where}` : `${s.name}, ${where}`);
  });
  return html`<div class="map"><svg viewBox="0 0 ${g.W} ${g.H}" role="group" aria-label=${o.label}>${baseMap(L, g)}${spots}${marks}</svg></div>`;
}
