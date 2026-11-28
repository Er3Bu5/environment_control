/* Text colour on a filled colour. Whichever of near-black and white contrasts more with it, by the WCAG sum: a brightness
   cut-off put white on HA's light blue at 2.6:1 and on a red accent at 3.7:1, both short of the 4.5:1 that text needs.
   Takes #rgb, #rrggbb or rgb(): the frame lets the browser turn any other colour into rgb() first. */
export function onColor(colour: string): string {
  const rgb = toRgb(colour);
  if (!rgb) return "#FFFFFF";
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return (lum + 0.05) / (0.0056 + 0.05) >= 1.05 / (lum + 0.05) ? "#111111" : "#FFFFFF";
}

function toRgb(c: string): number[] | null {
  const s = c.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2}|[0-9a-f])?$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,?\s*([\d.]+)\s*,?\s*([\d.]+)/i.exec(s);
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null;
}
