/* The look, as the design mock has it: Home Assistant's own shape, a top bar with view tabs over cards. Colours are
   custom properties the app sets from the theme the host sends, so Home Assistant's own colours can take over. */
import { css } from "lit";

/* The map's colours, as the mock has them: a sensor's height, a device's class, and the soil probes'. The same in both
   palettes, because each sits on its own fill. */
const MARKS = { above: "#FF9800", in: "#4CAF50", under: "#7E57C2", temp: "#FF9800", hum: "#2196F3", air: "#26A69A", sun: "#FBC02D", soil: "#8D6E63" } as const;

/* The panel's own palettes, used as they are for Light and Dark, and under HA's colours for Home Assistant. */
export const PALETTES = {
  light: { bg: "#FAFAFA", card: "#FFFFFF", tile: "#F5F5F5", line: "#E0E0E0", fg: "#212121", muted: "#727272", primary: "#03A9F4", "on-primary": "#FFFFFF", ok: "#388E3C", warn: "#EF6C00", crit: "#D32F2F", dead: "#8A8A8A", off: "#BDBDBD", ...MARKS },
  dark: { bg: "#111111", card: "#1C1C1C", tile: "#262626", line: "#2F2F2F", fg: "#E1E1E1", muted: "#9B9B9B", primary: "#03A9F4", "on-primary": "#FFFFFF", ok: "#66BB6A", warn: "#FFB74D", crit: "#EF5350", dead: "#8F8F8F", off: "#616161", ...MARKS },
} as const;

export const styles = css`
  :host { display: block; min-height: 100vh; background: var(--bg); color: var(--fg); font: 15px/1.45 Roboto, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
  * { box-sizing: border-box; }
  button, select, input { font: inherit; color: inherit; }
  button { cursor: pointer; }
  :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 24px; font-weight: 500; text-wrap: balance; }
  h2 { font-size: 18px; font-weight: 500; }
  h3 { font-size: 13px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }
  svg { flex: none; }

  .topbar { position: sticky; top: 0; z-index: 10; background: var(--bg); border-bottom: 1px solid var(--line); padding: 0 16px; }
  .bar { display: flex; align-items: center; gap: 12px; padding-block: 10px 4px; font-size: 19px; }
  .bar svg { width: 22px; height: 22px; fill: var(--muted); }
  .tabs { display: flex; gap: 20px; overflow-x: auto; scrollbar-width: none; }
  .tabs button { flex: none; border: 0; border-bottom: 2px solid transparent; background: none; padding: 8px 0; font-size: 14px; color: var(--muted); }
  .tabs button:hover { color: var(--fg); }
  .tabs button[aria-current="page"] { color: var(--primary); border-bottom-color: var(--primary); }

  main { padding: 18px 16px 48px; }
  .wrap { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px; }
  .zone-card { text-align: left; color: inherit; font: inherit; }
  .zone-card:hover { border-color: var(--primary); }
  .pill { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 500; white-space: nowrap; border: 1px solid currentColor; }
  .pill.plain { color: var(--muted); border-color: var(--line); }
  .pill.warn { color: var(--fg); background: color-mix(in srgb, var(--warn) 22%, var(--card)); border-color: var(--warn); }
  .pill.dashed { color: var(--muted); border-color: var(--line); border-style: dashed; }
  .notice { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; padding: 10px 14px; border-radius: 12px; background: color-mix(in srgb, var(--warn) 14%, var(--card)); }
  .notice.calm { background: color-mix(in srgb, var(--ok) 12%, var(--card)); }

  .task { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 14px; align-items: center; padding: 11px 0; border-top: 1px solid var(--line); }
  .task:first-child { border-top: 0; padding-top: 0; }
  .task > div:first-child { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .btn { border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: 7px 12px; font-size: 14px; }
  .btn:hover { border-color: var(--primary); }
  .btn.primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); font-weight: 500; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn.add { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px 9px 12px; font-size: 15px; font-weight: 500; }
  .btn.add svg { width: 20px; height: 20px; fill: currentColor; }

  .zmenu { position: relative; }
  .btn.burger { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 34px; padding: 0; }
  .btn.burger svg { width: 20px; height: 20px; fill: var(--fg); }
  .btn.burger[aria-expanded="true"] { border-color: var(--primary); }
  .menu { position: absolute; z-index: 10; right: 0; top: calc(100% + 4px); min-width: 220px; display: flex; flex-direction: column; padding: 4px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); box-shadow: 0 8px 24px #00000029; }
  .menu[hidden] { display: none; }
  .menu button { text-align: left; border: 0; background: none; padding: 10px 12px; border-radius: 6px; font-size: 14px; }
  .menu button:hover, .menu button:focus-visible { background: var(--tile); outline: none; }
  .menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
  .menu .remove { color: var(--crit); }

  .looks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .look { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 6px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); font-size: 14px; text-align: center; }
  .look svg { width: 24px; height: 24px; fill: var(--muted); }
  .look[aria-pressed="true"] { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); font-weight: 500; }
  .look[aria-pressed="true"] svg { fill: var(--primary); }

  .btn.danger { background: var(--crit); border-color: var(--crit); color: #FFFFFF; font-weight: 500; }
  .fixlink { border: 0; background: none; padding: 2px 0; font: inherit; color: var(--primary); cursor: pointer; text-align: left; }
  .fixlink:hover { text-decoration: underline; }
  .fixlink[hidden] { display: none; }
  .notice.fix { width: 100%; border: 0; justify-content: space-between; flex-wrap: nowrap; text-align: left; font: inherit; color: inherit; cursor: pointer; }
  .fixgo { flex: none; font-weight: 500; color: var(--primary); }
  .pill.ok { color: var(--ok); }

  textarea { font: inherit; resize: vertical; }
  .steps { display: flex; flex-wrap: wrap; gap: 4px 18px; list-style: none; margin: 0; padding: 0; font-size: 13px; color: var(--muted); }
  .steps li[aria-current="step"] { color: var(--primary); font-weight: 500; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); max-width: 440px; }
  .field input, .field textarea { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--tile); font-size: 15px; color: var(--fg); min-width: 0; width: 100%; }
  .field input[aria-invalid="true"] { border-color: var(--crit); }
  .task[aria-current="step"] strong { color: var(--primary); }

  .modal { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 16px; background: #00000080; }
  .dialog { display: flex; flex-direction: column; gap: 12px; width: min(480px, 100%); max-height: calc(100dvh - 32px); padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); }
  .dialog h2 { outline: none; }
  .dialog .row { justify-content: flex-end; }
  .review-scroll { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow-y: auto; }
  .review-list { flex: none; border: 1px solid var(--line); border-radius: 8px; }
  .review-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; padding: 8px 10px; font-size: 14px; }
  .review-row + .review-row { border-top: 1px solid var(--line); }
  .review-row strong { font-weight: 400; }
  .review-row b { font-weight: 500; }
  .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); max-width: calc(100vw - 32px); width: max-content; padding: 10px 14px; border-radius: 8px; background: var(--fg); color: var(--bg); font-size: 14px; z-index: 40; }

  .combine { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 8px; background: var(--tile); }
  .inavg { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); padding-top: 2px; }
  .dev-sub { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .picklist { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .pickwrap { border: 1px solid var(--line); border-radius: 8px; background: var(--tile); min-width: 0; }
  .pickwrap:has(.pickrow[aria-pressed="true"]) { border-color: var(--primary); }
  .pickrow { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px; border: 0; background: none; text-align: left; }
  .tick { width: 22px; height: 22px; flex: none; display: grid; place-items: center; border: 1px solid var(--off); border-radius: 6px; font-size: 14px; }
  .pickrow[aria-pressed="true"] .tick { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
  .pick-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .pick-text strong { font-weight: 500; overflow-wrap: anywhere; }
  .ents { display: flex; flex-direction: column; gap: 10px; padding: 0 10px 12px 42px; min-width: 0; }
  .pill.high { color: var(--fg); background: color-mix(in srgb, var(--warn) 22%, var(--card)); border-color: var(--warn); }
  /* Choices are radio chips rather than selects: the choice stays in view, and no system picker opens over the page. */
  fieldset.chips { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  fieldset.chips legend { padding: 0; margin-bottom: 4px; font-size: 13px; color: var(--muted); }
  .chiprow { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; min-height: 32px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 16px; background: var(--card); font-size: 13px; cursor: pointer; overflow-wrap: anywhere; max-width: 100%; }
  .chip input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
  .chip:has(input:checked) { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); font-weight: 500; }
  .chip:has(input:focus-visible) { outline: 2px solid var(--primary); outline-offset: 2px; }
  .chip.wait { border-style: dashed; color: var(--muted); }
  .ents .fixlink { align-self: flex-start; margin-top: -2px; }
  .review strong { font-weight: 500; }
  .review { display: flex; flex-direction: column; gap: 10px; }

  .map svg { display: block; width: 100%; height: auto; max-height: 460px; }
  .map text { font-family: inherit; }
  .map .hit { cursor: pointer; }
  .map .hit:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .key { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--muted); }
  .key span { display: inline-flex; align-items: center; gap: 5px; }
  .key i { width: 11px; height: 11px; display: inline-block; }
  .key i.unit { border: 1px solid var(--off); border-radius: 50%; background: var(--tile); }
  .key i.wall { border: 2px solid var(--muted); }
  .mk { width: 22px; height: 22px; border: 2px solid var(--c); border-radius: 6px; display: inline-grid; place-items: center; flex: none; background: var(--card); }
  .mk svg { width: 14px; height: 14px; fill: var(--c); }
  .mk.fill { background: var(--c); }
  .mk.fill svg { fill: #FFFFFF; }
  .mk.dash { border-style: dashed; }
  .key .mk { width: 16px; height: 16px; border-width: 1.5px; border-radius: 4px; }
  .key .mk svg { width: 11px; height: 11px; }
  .opt-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
  .stepper { display: inline-flex; align-items: center; gap: 8px; }
  .stepper button { width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); font-size: 18px; }
  .sensor-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 6px; min-width: 0; }
  .sensor-opt { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--tile); text-align: left; }
  .sensor-opt[aria-pressed="true"] { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
  .now { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; padding: 10px 12px; border-radius: 8px; background: var(--tile); }
  .now strong { font-weight: 500; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 220px)); gap: 12px; }

  ul { list-style: none; margin: 0; padding: 0; }
  li.device { padding: 10px 0; border-top: 1px solid var(--line); }
  .name { font-weight: 500; overflow-wrap: anywhere; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  details { margin-top: 6px; font-size: 13px; }
  summary { cursor: pointer; color: var(--muted); }
  li.entity { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 4px 0; }
  .eid { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .state { text-align: right; white-space: nowrap; }
`;
