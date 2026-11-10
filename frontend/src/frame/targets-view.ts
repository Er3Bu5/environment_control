/* The VPD chart, drawn as the design mock draws it: temperature across, humidity down, every cell its leaf VPD at the
   zone's chart offset, coloured by Athena's ranges. Cells inside the ideal zone are bright, cells short of critical
   are faded, the rest dark. Only the thing being edited is drawn strongly, with labelled lines. */
import { svg, type TemplateResult } from "lit";
import { calcVpd } from "./readings";
import { HANDLES, type PeriodBands, RH_LOW, RH_TOP, SLOT_NAME, T_MAX, T_MIN, type TargetsDraft, rhAt, vGeom, vzone } from "./targets";

const ZONE_COLOR = ["var(--v0)", "var(--v1)", "var(--v2)", "var(--v3)", "var(--v0)"];
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function flag(x: number, y: number, text: string, on: boolean) {
  const w = 52, cx = Math.round(x);
  return svg`<g pointer-events="none"><rect x=${cx - w / 2} y=${y} width=${w} height="18" rx="4" fill=${on ? "var(--vink)" : "var(--primary)"}></rect><text x=${cx} y=${y + 13} text-anchor="middle" fill="#FFFFFF" style="font-size:11px">${text}</text></g>`;
}

export function vpdChart(d: TargetsDraft, b: PeriodBands, leaf: number, showText: boolean) {
  const g = vGeom(), { X, Y } = g, on = (k: string) => d.edit === k;
  const at = (k: "temperature" | "humidity" | "vpd", i: number) => b[k][i] ?? 0;
  const cells: TemplateResult[] = [], lines: TemplateResult[] = [], flags: TemplateResult[] = [];
  for (let rh = RH_TOP; rh >= RH_LOW; rh -= 5) {
    cells.push(svg`<text x=${g.L - 6} y=${Y(rh) + 4} text-anchor="end" fill="var(--muted)">${rh}%</text>`);
    for (let t = T_MIN; t <= T_MAX; t++) {
      const p = calcVpd(t, rh, leaf);
      const within = (i: number, j: number) => t >= at("temperature", i) && t <= at("temperature", j) && rh >= at("humidity", i) && rh <= at("humidity", j) && p >= at("vpd", i) && p <= at("vpd", j);
      const opacity = within(1, 3) ? 1 : within(0, 4) ? 0.55 : 0.18;
      cells.push(svg`<g opacity=${opacity}><rect x=${X(t) - g.cw / 2} y=${Y(rh) - g.ch / 2} width=${g.cw - 1} height=${g.ch - 1} fill=${ZONE_COLOR[vzone(p)]}></rect>${showText ? svg`<text x=${X(t) - 0.5} y=${Y(rh) + 3.5} text-anchor="middle" fill="var(--vink)" style="font-size:10px">${p.toFixed(1)}</text>` : null}</g>`);
    }
  }
  for (let t = T_MIN; t <= T_MAX; t += 2) cells.push(svg`<text x=${X(t)} y=${g.H - 7} text-anchor="middle" fill="var(--muted)">${t}°</text>`);
  const stroke = (k: string, i: number) => (on(k) ? (d.sel === i ? 4 : 2.5) : 1), faded = (k: string) => (on(k) ? 1 : 0.3);
  for (const i of HANDLES) {
    const t = clamp(at("temperature", i), T_MIN, T_MAX), rh = clamp(at("humidity", i), RH_LOW, RH_TOP), vp = at("vpd", i);
    lines.push(svg`<line x1=${X(t)} y1=${g.T} x2=${X(t)} y2=${g.bottom} stroke="var(--vink)" stroke-width=${stroke("temperature", i)} opacity=${faded("temperature")}></line>`);
    lines.push(svg`<line x1=${g.L} y1=${Y(rh)} x2=${g.right} y2=${Y(rh)} stroke="var(--vink)" stroke-width=${stroke("humidity", i)} opacity=${faded("humidity")}></line>`);
    let path = "", pen = false;
    for (let c = T_MIN; c <= T_MAX; c += 0.25) {
      const r = rhAt(c, vp, leaf);
      if (r > RH_TOP || r < RH_LOW) {
        pen = false;
        continue;
      }
      path += `${pen ? "L" : "M"}${X(c).toFixed(1)} ${Y(r).toFixed(1)}`;
      pen = true;
    }
    if (path) lines.push(svg`<path d=${path} fill="none" stroke="var(--vink)" stroke-width=${stroke("vpd", i)} stroke-dasharray="6 4" opacity=${faded("vpd")}></path>`);
    const label = `${SLOT_NAME[i]} ${at(on("vpd") ? "vpd" : on("humidity") ? "humidity" : "temperature", i)}`;
    if (on("temperature")) flags.push(flag(clamp(X(t), g.L + 26, g.right - 26), i === 0 || i === 4 ? 2 : 24, label, d.sel === i));
    if (on("humidity")) flags.push(flag(g.right - (i === 0 || i === 4 ? 30 : 86), Y(rh) - 9, label, d.sel === i));
    if (on("vpd")) {
      let c = { 0: 33, 1: 30, 3: 27, 4: 24 }[i] as number;
      while (c > T_MIN && (rhAt(c, vp, leaf) > RH_TOP || rhAt(c, vp, leaf) < RH_LOW)) c -= 0.5;
      flags.push(flag(X(c), Y(clamp(rhAt(c, vp, leaf), RH_LOW, RH_TOP)) - 9, label, d.sel === i));
    }
  }
  const T = b.temperature[2], RH = b.humidity[2], big = on("target");
  const target =
    T === null || RH === null
      ? null
      : svg`<g><circle cx=${X(clamp(T, T_MIN, T_MAX))} cy=${Y(clamp(RH, RH_LOW, RH_TOP))} r=${big ? 15 : 10} fill="none" stroke="#FFFFFF" stroke-width="5"></circle><circle cx=${X(clamp(T, T_MIN, T_MAX))} cy=${Y(clamp(RH, RH_LOW, RH_TOP))} r=${big ? 15 : 10} fill=${big ? "#FFFFFF66" : "none"} stroke="var(--vink)" stroke-width="2.5"></circle></g>`;
  return svg`<svg viewBox="0 0 ${g.W} ${g.H}" role="img" aria-label="VPD chart of temperature against humidity">${cells}${lines}${target}${flags}</svg>`;
}
