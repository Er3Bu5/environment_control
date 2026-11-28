/* The VPD chart, drawn as the design mock draws it: temperature across, humidity down, every cell its leaf VPD at the
   zone's chart offset, coloured by Athena's ranges. Cells inside the ideal zone are bright, cells short of critical
   are faded, the rest dark. Only the thing being edited is drawn strongly, with labelled lines. */
import { svg, type TemplateResult } from "lit";
import { calcVpd } from "./readings";
import { type Axes, HANDLES, type PeriodBands, SLOT_NAME, type TargetsDraft, chartFlags, rhAt, vGeom, vzone } from "./targets";

const ZONE_COLOR = ["var(--v0)", "var(--v1)", "var(--v2)", "var(--v3)", "var(--v0)"];
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function flag(x: number, y: number, text: string, on: boolean, slot: number) {
  const w = 52, h = 18, cx = Math.round(x);
  return svg`<g pointer-events="none" data-vflag=${slot}><rect x=${cx - w / 2 + 0.5} y=${y + 0.5} width=${w - 1} height=${h - 1} rx="4" fill=${on ? "var(--primary)" : "var(--tile)"} stroke=${on ? "var(--primary)" : "var(--off)"}></rect><text x=${cx} y=${y + 13} text-anchor="middle" fill=${on ? "var(--on-primary)" : "var(--muted)"} style="font-size:11px">${text}</text></g>`;
}

export function vpdChart(d: TargetsDraft, b: PeriodBands, leaf: number, showText: boolean, axes: Axes) {
  const g = vGeom(axes), { X, Y } = g, on = (k: string) => d.edit === k;
  const at = (k: "temperature" | "humidity" | "vpd", i: number) => b[k][i] ?? 0;
  const cells: TemplateResult[] = [], lines: TemplateResult[] = [], top: TemplateResult[] = [], flags: TemplateResult[] = [], flagTop: TemplateResult[] = [];
  for (let rh = g.rh.hi; rh >= g.rh.lo; rh -= g.rh.step) {
    cells.push(svg`<text x=${g.L - 6} y=${Y(rh) + 4} text-anchor="end" fill="var(--muted)">${rh}%</text>`);
    for (let t = g.t.lo; t <= g.t.hi; t += g.t.step) {
      const p = calcVpd(t, rh, leaf);
      const within = (i: number, j: number) => t >= at("temperature", i) && t <= at("temperature", j) && rh >= at("humidity", i) && rh <= at("humidity", j) && p >= at("vpd", i) && p <= at("vpd", j);
      const opacity = within(1, 3) ? 1 : within(0, 4) ? 0.55 : 0.18;
      cells.push(svg`<g opacity=${opacity}><rect x=${X(t) - g.cw / 2} y=${Y(rh) - g.ch / 2} width=${g.cw - 1} height=${g.ch - 1} fill=${ZONE_COLOR[vzone(p)]}></rect>${showText ? svg`<text x=${X(t) - 0.5} y=${Y(rh) + 3.5} text-anchor="middle" fill="var(--vink)" style="font-size:10px">${p.toFixed(1)}</text>` : null}</g>`);
    }
  }
  /* Every other cell is labelled, on multiples of two steps, so the labels stay round numbers. */
  for (let t = g.t.lo; t <= g.t.hi; t += g.t.step) if ((t / g.t.step) % 2 === 0) cells.push(svg`<text x=${X(t)} y=${g.H - 7} text-anchor="middle" fill="var(--muted)" data-vtick=${t}>${t}°</text>`);
  const stroke = (k: string, i: number) => (on(k) ? (d.sel === i ? 4 : 2.5) : 1), faded = (k: string) => (on(k) ? 1 : 0.3);
  /* The selected line is drawn last, over any line it coincides with, with a light edge so the accent reads on every cell colour. */
  const picked = (k: string, i: number) => on(k) && d.sel === i, ink = (k: string, i: number) => (picked(k, i) ? "var(--primary)" : "var(--vline)");
  const put = (k: string, i: number, mark: TemplateResult, edge: TemplateResult) => (picked(k, i) ? top.push(edge, mark) : lines.push(mark));
  const line = (x1: number, y1: number, x2: number, y2: number, k: string, i: number) =>
    put(
      k,
      i,
      svg`<line data-vline=${`${k}:${i}`} x1=${x1} y1=${y1} x2=${x2} y2=${y2} stroke=${ink(k, i)} stroke-width=${stroke(k, i)} opacity=${faded(k)}></line>`,
      svg`<line x1=${x1} y1=${y1} x2=${x2} y2=${y2} stroke="#FFFFFF" stroke-width="8" opacity="0.7"></line>`,
    );
  const label = (x: number, y: number, text: string, i: number) => (d.sel === i ? flagTop : flags).push(flag(x, y, text, d.sel === i, i));
  for (const i of HANDLES) {
    const t = clamp(at("temperature", i), g.t.lo, g.t.hi), rh = clamp(at("humidity", i), g.rh.lo, g.rh.hi), vp = at("vpd", i);
    line(X(t), g.T, X(t), g.bottom, "temperature", i);
    line(g.L, Y(rh), g.right, Y(rh), "humidity", i);
    let path = "", pen = false;
    for (let c = g.t.lo; c <= g.t.hi; c += g.t.step / 4) {
      const r = rhAt(c, vp, leaf);
      if (r > g.rh.hi || r < g.rh.lo) {
        pen = false;
        continue;
      }
      path += `${pen ? "L" : "M"}${X(c).toFixed(1)} ${Y(r).toFixed(1)}`;
      pen = true;
    }
    if (path)
      put(
        "vpd",
        i,
        svg`<path data-vline=${`vpd:${i}`} d=${path} fill="none" stroke=${ink("vpd", i)} stroke-width=${stroke("vpd", i)} stroke-dasharray="6 4" opacity=${faded("vpd")}></path>`,
        svg`<path d=${path} fill="none" stroke="#FFFFFF" stroke-width="8" opacity="0.7"></path>`,
      );
  }
  const spots = chartFlags(d.edit, b, g, leaf);
  for (const i of HANDLES) {
    const spot = spots[i];
    if (spot && d.edit !== "target") label(spot.x, spot.y, `${SLOT_NAME[i]} ${at(d.edit, i)}`, i);
  }
  const T = b.temperature[2], RH = b.humidity[2], big = on("target");
  const target =
    T === null || RH === null
      ? null
      : svg`<g><circle cx=${X(clamp(T, g.t.lo, g.t.hi))} cy=${Y(clamp(RH, g.rh.lo, g.rh.hi))} r=${big ? 15 : 10} fill="none" stroke="#FFFFFF" stroke-width="5"></circle><circle cx=${X(clamp(T, g.t.lo, g.t.hi))} cy=${Y(clamp(RH, g.rh.lo, g.rh.hi))} r=${big ? 15 : 10} fill=${big ? "#FFFFFF66" : "none"} stroke=${big ? "var(--primary)" : "var(--vline)"} stroke-width="2.5"></circle></g>`;
  return svg`<svg viewBox="0 0 ${g.W} ${g.H}" role="img" aria-label="VPD chart of temperature against humidity">${cells}${lines}${target}${top}${flags}${flagTop}</svg>`;
}
