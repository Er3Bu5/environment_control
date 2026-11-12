/* The look, as the design mock has it: Home Assistant's own shape, a top bar with view tabs over cards. Colours are
   custom properties the app sets from the theme the host sends, so Home Assistant's own colours can take over. */
import { css } from "lit";

/* The map's colours, as the mock has them: a sensor's height, a device's class, and the soil probes'. The same in both
   palettes, because each sits on its own fill. */
const MARKS = { above: "#FF9800", in: "#4CAF50", under: "#7E57C2", temp: "#FF9800", hum: "#2196F3", air: "#26A69A", vpd: "#4CAF50", sun: "#FBC02D", soil: "#8D6E63", day: "#FBC02D" } as const;

/* The panel's own palettes, used as they are for Light and Dark, and under HA's colours for Home Assistant. */
export const PALETTES = {
  light: { v0: "#B0BEC5", v1: "#A5D6A7", v2: "#FFCC80", v3: "#CE93D8", vink: "#212121", shade: "#5C6BC014", band: "#9E9E9E2E", ideal: "#4CAF5059", llow: "#000000", lhigh: "#F1C40F", night: "#DDE1EA", tnom: "#43A047", tramp: "#9E9E9E", tcrit: "#D32F2F", "ramp-text": "#616161", bg: "#FAFAFA", card: "#FFFFFF", tile: "#F5F5F5", line: "#E0E0E0", fg: "#212121", muted: "#727272", primary: "#03A9F4", "on-primary": "#FFFFFF", ok: "#388E3C", warn: "#EF6C00", crit: "#D32F2F", dead: "#8A8A8A", off: "#BDBDBD", ...MARKS },
  dark: { v0: "#B0BEC5", v1: "#A5D6A7", v2: "#FFCC80", v3: "#CE93D8", vink: "#212121", shade: "#9FA8DA14", band: "#FFFFFF14", ideal: "#66BB6A55", llow: "#616161", lhigh: "#F1C40F", night: "#2A2F3A", tnom: "#66BB6A", tramp: "#757575", tcrit: "#EF5350", "ramp-text": "#BDBDBD", bg: "#111111", card: "#1C1C1C", tile: "#262626", line: "#2F2F2F", fg: "#E1E1E1", muted: "#9B9B9B", primary: "#03A9F4", "on-primary": "#FFFFFF", ok: "#66BB6A", warn: "#FFB74D", crit: "#EF5350", dead: "#8F8F8F", off: "#616161", ...MARKS },
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

  /* The page menu's button sits at the top left of the page, and each page's heading is centred beside it. */
  .wrap { position: relative; }
  /* The page menu's button and the page's heading share the top row: the button at the left, at the foot of the
     heading block, and the heading centred. They're two items in one grid cell, so the button follows the heading's
     height whatever it holds. */
  .zmenu.navmenu { grid-area: 1 / 1; align-self: end; justify-self: start; z-index: 12; }
  .navmenu .menu { left: 0; right: auto; }
  .menu [aria-current="page"] { color: var(--primary); font-weight: 500; }
  .navmenu + * { grid-area: 1 / 1; min-height: 36px; padding-inline: 48px; text-align: center; }
  .navmenu + * h1 { line-height: 34px; }
  /* A zone's heading row: the menu button over the left-hand column, the name and its details in the middle, and
     View targets at the right, the two buttons level with the foot of the details. */
  .navmenu + .pagehead { padding-inline: 0; }
  .pagehead { display: grid; grid-template-columns: minmax(44px, 1fr) minmax(0, auto) minmax(max-content, 1fr); align-items: end; gap: 8px; }
  .pagehead > div { grid-column: 2; grid-row: 1; min-width: 0; }
  .pagehead > .btn { grid-column: 3; grid-row: 1; justify-self: end; }

  main { padding: 18px 16px 48px; }
  .wrap { max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; }
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
  /* What each zone's History opens on: a line per zone, its name then the two choices, which wrap under it on a phone. */
  .opens { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
  .opens-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; }
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
  .steps button { padding: 6px 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
  .steps button:hover { color: var(--fg); text-decoration: underline; }
  .steps li[aria-current="step"] { padding: 6px 0; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); max-width: 440px; }
  .field input, .field textarea { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--tile); font-size: 15px; color: var(--fg); min-width: 0; width: 100%; }
  .field input[aria-invalid="true"] { border-color: var(--crit); }
  .task[aria-current="step"] strong { color: var(--primary); }

  .modal { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 16px; background: #00000080; }
  .dialog { display: flex; flex-direction: column; gap: 12px; width: min(480px, 100%); max-height: calc(100dvh - 32px); padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); }
  .dialog h2 { outline: none; }
  .dialog.wide { width: min(760px, 100%); }
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
  /* The choice itself is invisible and covers its whole chip, so a tap or a click anywhere on the chip lands on it.
     At 1px it sat at a fraction of a pixel on some page widths, where a click aimed at it hit the chip's text instead. */
  .chip { position: relative; }
  .chip input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
  .chip input:disabled { cursor: not-allowed; }
  .chip:has(input:checked) { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); font-weight: 500; }
  .chip:has(input:focus-visible) { outline: 2px solid var(--primary); outline-offset: 2px; }
  /* A chip that is one of several ticked says so with a tick, so it doesn't read as the one choice of a set. The tick
     has empty alternative text: the box already says it's ticked, and the tick mustn't become part of its name. */
  .chip:has(input[type="checkbox"]:checked)::before { content: "✓" / ""; margin-right: 5px; font-size: 12px; }
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

  /* Live readings, as the mock draws them: tinted-icon tiles, each reading on a line-and-dot band track. */
  .ic { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; flex: none; background: color-mix(in srgb, var(--c) 20%, transparent); }
  .ic svg { width: 21px; height: 21px; fill: var(--c); }
  .pill.low, .pill.high { color: var(--ramp-text); }
  .pill.critlow, .pill.crithigh { color: #FFFFFF; background: var(--crit); border-color: var(--crit); }
  .pill.dead { color: var(--dead); border-style: dashed; }
  .notice.critical { background: color-mix(in srgb, var(--crit) 16%, var(--card)); }
  .period { display: flex; flex-direction: column; gap: 5px; }
  .period-top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 10px; font-size: 13px; }
  .period-top strong { font-weight: 500; }
  .lux { margin-left: 8px; color: var(--muted); }
  .strip { position: relative; height: 8px; border-radius: 4px; background: var(--night); overflow: hidden; }
  .strip i { position: absolute; top: 0; bottom: 0; background: var(--day); }
  .strip b { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--fg); }
  .track { position: relative; height: 14px; border-bottom: 1px solid var(--off); min-width: 0; }
  .track .bandc { position: absolute; top: 3px; bottom: 0; left: 0; right: 0; background: var(--tcrit); }
  .track.unset .bandc { background: var(--line); }
  .track .bandr { position: absolute; top: 3px; bottom: 0; background: var(--tramp); }
  .track .bandi { position: absolute; top: 3px; bottom: 0; background: var(--tnom); }
  .track .tick { position: absolute; top: 3px; bottom: 0; width: 1px; background: var(--fg); }
  .track .dot { position: absolute; bottom: -5px; width: 9px; height: 9px; margin-left: -6px; border-radius: 50%; border: 2px solid var(--card); box-sizing: content-box; background: var(--fg); }
  .track .dot.ok { background: var(--tnom); }
  .track .dot.low, .track .dot.high { background: var(--tramp); }
  .track .dot.critlow, .track .dot.crithigh { background: var(--crit); }
  .rows { display: flex; flex-direction: column; gap: 12px; }
  .mrow { display: grid; grid-template-columns: 36px 78px minmax(0, 1fr) 76px; gap: 8px; align-items: center; }
  .mrow .t1 { font-size: 12px; color: var(--muted); }
  .mrow .t2 { font-size: 17px; font-weight: 500; line-height: 1.15; white-space: nowrap; }
  .mrow .t2 span { font-size: 12px; font-weight: 400; color: var(--muted); margin-left: 2px; }
  .mrow .pillcell { justify-self: end; }
  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .tile, .lcard { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .tile-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .tile .name, .lcard .name { font-size: 13px; color: var(--muted); }
  .tile .val, .lcard .val { font-size: 22px; font-weight: 500; line-height: 1.1; }
  .tile .val small, .lcard .val small { font-size: 13px; font-weight: 400; color: var(--muted); }
  /* A row of tiles shares its five rows, as the mock has it: name and value, notes, track, limits, state. So the
     tracks line up across the row however many lines of notes a tile has. */
  .tile { display: grid; grid-row: span 5; grid-template-rows: subgrid; align-items: start; }
  .lcard { grid-row: span 5; }
  .tnotes { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .tavg { font-size: 12px; color: var(--muted); }
  .range { display: flex; justify-content: space-between; gap: 2px; color: var(--muted); }
  .range span { display: flex; flex-direction: column; align-items: center; font-size: 10px; }
  .range b { font-size: 12px; font-weight: 500; color: var(--fg); }
  .detail { padding: 10px 12px; border-radius: 8px; background: var(--tile); font-size: 13px; display: flex; flex-direction: column; gap: 2px; }
  .tbl-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th { text-align: left; font-size: 12px; font-weight: 500; color: var(--muted); padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 9px 12px 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  td .sub { display: block; font-size: 12px; color: var(--muted); }
  @media (max-width: 700px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

  /* Controls sit beside the map on a wide screen and above it on a narrow one, as the mock has them. */
  .split { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .cgroup { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .ctl-reading { display: inline-flex; align-items: center; gap: 8px; font-weight: 500; }
  .devs { display: flex; flex-direction: column; gap: 8px; }
  .dev { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 10px; border-radius: 12px; background: var(--tile); min-width: 0; }
  .dev-text { flex: 1 1 220px; min-width: 0; }
  .dev-name { font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
  .dev-ctl { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 32px; margin-left: auto; max-width: 100%; }
  .sw { width: 50px; min-height: 32px; display: inline-flex; align-items: center; justify-content: flex-start; padding: 3px 6px; border: 1px solid var(--off); border-radius: 16px; background: var(--card); cursor: pointer; }
  .sw i { width: 18px; height: 18px; border-radius: 50%; background: var(--off); }
  .sw.on { justify-content: flex-end; border-color: var(--primary); }
  .sw.on i { background: var(--primary); }
  .sw:disabled, .dial.busy, .ctl-modes .chip:has(input:disabled) { opacity: .45; cursor: not-allowed; }
  /* The dial: an arc open at the bottom, with the plus and minus buttons tucked into the gap. Only the arc itself
     takes a finger, so a thumb scrolling the page over the middle of it changes nothing. */
  .dial { position: relative; width: 140px; display: grid; justify-items: center; flex: none; }
  .dial svg { display: block; width: 140px; height: 140px; overflow: visible; }
  .dial path { fill: none; stroke-width: 10; stroke-linecap: round; }
  .dial .trk { stroke: color-mix(in srgb, var(--fg) 12%, transparent); }
  .dial .fil { stroke: var(--c); }
  .dial .hit { stroke: transparent; stroke-width: 28; stroke-linecap: butt; pointer-events: stroke; touch-action: none; cursor: pointer; }
  .dial.busy .hit { pointer-events: none; }
  .dial .thumb { fill: #fff; stroke: #0000004d; stroke-width: 1; pointer-events: none; }
  .dial .unit-dot { fill: var(--fg); opacity: .55; pointer-events: none; }
  .dial:has(input:focus-visible) .thumb { stroke: var(--fg); stroke-width: 2.5; }
  .dial-mid { position: absolute; inset: 0 0 auto 0; height: 140px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; pointer-events: none; }
  .dial-cap { font-size: 11px; color: var(--muted); }
  .dial-num { font-size: 28px; line-height: 1; font-weight: 400; }
  .dial-num small { margin-left: 1px; font-size: 13px; color: var(--muted); }
  .dial-steps { display: flex; gap: 8px; margin-top: -24px; }
  .dial-steps button { width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border: 1px solid var(--line); border-radius: 50%; background: var(--card); font-size: 18px; line-height: 1; }
  .dial-steps button:disabled { opacity: .45; cursor: not-allowed; }
  .dial.busy .dial-steps button:disabled { opacity: 1; }
  /* A row with modes: the name at the left, the modes centred in the space between, then the dial, and the switch set
     apart from the dial so a thumb on one isn't on the other. */
  .dev:has(.dev-modes) .dev-text { flex: 0 1 auto; }
  .dev-modes { flex: 1 1 260px; display: flex; justify-content: center; min-width: 0; }
  .dev-modes .chiprow { justify-content: center; }
  /* Too narrow for all of that on one line: the modes go under the device's name, and the dial stands beside the two
     of them, so the row is still only as tall as its dial. The modes start under the icon, not under the name: those
     50px are what keep five of them on one line on a folding phone. The empty first and last rows share the height
     left over, which centres the name and its modes against the dial. Narrower still, the modes take a line of their
     own. */
  @media (max-width: 999px), (min-width: 1100px) {
    .dev:has(.dev-modes) .dev-text { flex: 1 1 0; }
    .dev-modes { flex-basis: 100%; justify-content: flex-start; margin-top: 6px; }
    .dev-modes .chiprow { justify-content: flex-start; }
  }
  @media (min-width: 620px) and (max-width: 999px), (min-width: 1100px) {
    .dev:has(.dev-modes) { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: 1fr auto auto 1fr; gap: 0 10px; }
    .dev:has(.dev-modes) > .ic { grid-area: 2 / 1; }
    .dev:has(.dev-modes) > .dev-text { grid-area: 2 / 2; }
    .dev:has(.dev-modes) > .dev-modes { grid-area: 3 / 1 / 4 / 3; margin-top: 14px; }
    .dev:has(.dev-modes) > .dev-ctl { grid-area: 1 / 3 / 5 / 4; flex-wrap: nowrap; margin-left: 22px; }
    .dev:has(.dev-modes) > .ctl-status { grid-area: 5 / 1 / 6 / -1; margin-top: 8px; }
  }
  /* On a wide screen a group's devices stand two abreast, so a row isn't stretched across the page with nothing in its
     middle. Each row is then about as wide as a whole row on a mid-width screen, and is laid out the same way. Half a
     page holds four modes on one line. Two in a line are as tall as each other. */
  @media (min-width: 1100px) {
    .devs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .dev-text { flex-basis: 160px; }
    .dev:has(.dev-modes) > .dev-ctl { margin-left: 6px; }
  }
  .ctl-status { flex-basis: 100%; font-size: 12px; color: var(--muted); }
  .ctl-status.crit { color: var(--crit); }
  .ctl-status.warn { color: var(--fg); }
  .ctl-status.warn::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: var(--warn); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  ul { list-style: none; margin: 0; padding: 0; }
  li.device { padding: 10px 0; border-top: 1px solid var(--line); }
  .name { font-weight: 500; overflow-wrap: anywhere; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  details { margin-top: 6px; font-size: 13px; }
  /* Sensor Calibration, as the mock has it: a row per sensor, the box holding the size and two buttons the direction. */
  .seg { display: inline-flex; flex-wrap: wrap; gap: 4px; }
  .seg button { border: 1px solid var(--line); background: none; padding: 3px 10px; min-height: 32px; border-radius: 16px; font-size: 13px; color: var(--muted); }
  .seg button[aria-pressed="true"] { background: color-mix(in srgb, var(--primary) 18%, transparent); border-color: var(--primary); color: var(--fg); }
  .seg button:disabled { opacity: .5; cursor: not-allowed; }
  .now { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; padding: 10px 12px; border-radius: 8px; background: var(--tile); }
  .now strong, .lrow strong, .lbasis strong { font-weight: 500; }
  .lrows { display: flex; flex-direction: column; gap: 8px; }
  .lrow, .lbasis { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 12px; background: var(--tile); min-width: 0; }
  .lbasis { gap: 6px; }
  .lrow-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; }
  .lfield { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .lcell { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
  .lcell input { width: 72px; padding: 7px 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); font-size: 14px; font-weight: 500; text-align: center; }
  .lcell input:focus { outline: 2px solid var(--primary); outline-offset: -1px; }
  .lcell input[aria-invalid="true"] { border-color: var(--crit); box-shadow: 0 0 0 1px var(--crit); }
  .lcell input:disabled { opacity: .6; }
  .lstatus { font-size: 13px; color: var(--warn); }
  .lstatus:empty { display: none; }
  .issues { display: flex; flex-direction: column; gap: 10px; }
  .issues:empty { display: none; }
  @media (pointer: coarse) { .lcell input { font-size: 16px; } }

  /* The draft bar: pinned to the foot of the window on a page edited freely, while anything differs from what's saved. */
  .draftbar { position: fixed; z-index: 20; left: 50%; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); width: min(820px, calc(100vw - 32px)); display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; border-radius: 14px; background: var(--fg); color: var(--bg); box-shadow: 0 8px 24px #0000003D; }
  :host(.drafting) main { padding-bottom: 96px; }
  :host(.drafting) .toast { bottom: calc(92px + env(safe-area-inset-bottom, 0px)); }
  :host(.typing) .draftbar { display: none; }
  .draft-count { display: inline-flex; flex: none; align-items: center; justify-content: center; min-width: 26px; height: 26px; padding: 0 6px; border-radius: 13px; background: var(--sun); color: #212121; font-size: 13px; font-weight: 700; }
  .draft-text { flex: 1; min-width: 0; font-size: 14px; }
  .draft-text strong { font-weight: 500; }
  .draft-why { opacity: .8; }
  .draft-discard, .draft-review { flex: none; height: 44px; padding: 0 14px; border-radius: 10px; font-size: 14px; white-space: nowrap; }
  .draft-discard { border: 1px solid color-mix(in srgb, var(--bg) 35%, transparent); background: transparent; color: inherit; }
  .draft-review { border: 0; background: var(--bg); color: var(--fg); font-weight: 500; }
  .draft-review:disabled { opacity: .5; cursor: not-allowed; }
  /* A wizard's Back and Next in the same bar. With nothing unsaved and nothing to fix, a phone shows only the buttons. */
  .wizbar .fixlink { color: inherit; text-decoration: underline; }
  .wizbar[data-bare] .draft-text { opacity: .8; }
  /* With only its buttons to hold, the bar is as wide as they are, not a long empty strip with a button at its end. */
  .wizbar[data-bare] { width: auto; max-width: calc(100vw - 32px); padding-left: 12px; }
  .wizbar[data-bare] .draft-text:empty { display: none; }
  @media (max-width: 640px) {
    .draftbar { flex-wrap: wrap; gap: 8px 10px; padding: 10px; }
    .draft-text { flex: 1 1 calc(100% - 36px); }
    .draftbar:not([data-blocked]) .draft-why { display: none; }
    .wizbar[data-bare] .draft-text { display: none; }
    .wizbar[data-bare] { width: min(820px, calc(100vw - 32px)); padding-left: 10px; }
    .draft-discard { flex: 1; }
    .draft-review { flex: 2; }
    :host(.drafting) main { padding-bottom: 136px; }
    :host(.drafting) .toast { bottom: calc(132px + env(safe-area-inset-bottom, 0px)); }
  }

  /* History, as the mock draws it. The chart scrolls the page vertically under a finger and reads a point sideways. */
  .chart svg { display: block; width: 100%; height: auto; touch-action: pan-y; outline-offset: 2px; }
  .chart text { font-size: 11px; fill: var(--muted); }
  .chart-note { font-size: 13px; color: var(--muted); }
  table.cstats { font-size: 14px; font-variant-numeric: tabular-nums; }
  .cstats th, .cstats td { padding: 5px 0 5px 10px; text-align: right; vertical-align: top; white-space: nowrap; }
  .cstats th:first-child, .cstats td:first-child { padding-left: 0; text-align: left; font-size: 13px; }
  .cstats td:first-child { white-space: normal; }
  .cstats td:first-child i { display: inline-block; width: 11px; height: 2px; margin-right: 6px; vertical-align: middle; }
  .cstats td .sub { font-size: 11px; }
  .cstats tbody tr:last-child td { border-bottom: 0; }
  .lcard .lline { display: block; width: calc(100% + 24px); margin: auto -12px -12px; height: 60px; }
  .mrow .lspark { grid-column: 3 / -1; display: block; width: 100%; height: 34px; }

  /* Targets, day and night: switches to follow, and the length of the day as a strip. */
  .follow { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--tile); font-size: 14px; }
  .follow:has(input:checked) { border-color: var(--primary); }
  .follow > span:nth-of-type(1) { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .now .sched-strip { flex: 1 1 160px; min-width: 120px; }

  /* The zone's Day and Night limits, column under column. */
  table.limits { table-layout: fixed; }
  table.limits th:first-child { width: 30%; }
  /* Targets: the VPD chart and its boxes, as the mock has them. The chart takes a finger's drag for itself. */
  .tdlinks { display: grid; gap: 8px; }
  .stepper { display: inline-flex; align-items: center; gap: 8px; }
  .stepper[hidden] { display: none; }
  .stepper button { width: 32px; height: 32px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .vgrid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 1fr); gap: 14px; align-items: start; }
  .vchart { touch-action: none; user-select: none; -webkit-user-select: none; cursor: crosshair; }
  .vchart svg { max-height: none; }
  .vchart svg text { font-size: 12px; }
  .vmain, .vside { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .seg.vtabs { display: flex; }
  .vtabs button { flex: 1 1 auto; }
  .vrow { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--tile); text-align: center; }
  .vrow[data-on="true"] { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
  .vrow-name { grid-column: 1 / -1; padding: 0; border: 0; background: none; color: var(--fg); text-align: left; font-size: 13px; font-weight: 500; }
  button.vrow-name { cursor: pointer; }
  .vcell { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 10px; color: var(--muted); }
  .vcell input { width: 100%; min-width: 0; padding: 6px 2px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); font-size: 14px; font-weight: 500; text-align: center; }
  .vcell.vt input { color: var(--primary); }
  .vcell .vdash { padding: 6px 2px; border: 1px dashed var(--line); border-radius: 6px; font-size: 14px; text-align: center; }
  .vcell.vlast { grid-column: 5; }
  .vrow[data-vrow="light"] .vcell { grid-row: 2; }
  .vnote { grid-row: 2; grid-column: 2 / -1; align-self: center; margin: 0; padding: 0 4px; font-size: 11px; line-height: 1.35; color: var(--muted); text-align: left; }
  .vnote.vleft { grid-column: 1 / 5; }
  .vcell input:focus { outline: 2px solid var(--primary); outline-offset: -1px; }
  .vcell input[aria-invalid="true"] { border-color: var(--crit); box-shadow: 0 0 0 1px var(--crit); }
  .vcell input:disabled { opacity: .6; }
  @media (max-width: 960px) { .vgrid { grid-template-columns: minmax(0, 1fr); } }
  @media (pointer: coarse) { .vcell input { font-size: 16px; } }
  /* Room to scroll a typed box up above a phone's keyboard. */
  :host(.revealing) main { padding-bottom: 70vh; }

  /* Helper search boxes: a field, and a short list of matches under it. */
  .picker { display: flex; flex-direction: column; gap: 4px; position: relative; }
  .picker .field { max-width: none; }
  .picklist-menu { list-style: none; margin: 0; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); box-shadow: 0 6px 18px #00000026; }
  .picklist-menu li { display: flex; flex-direction: column; gap: 1px; padding: 8px 10px; border-radius: 6px; cursor: pointer; overflow-wrap: anywhere; }
  .picklist-menu li.active, .picklist-menu li:hover { background: color-mix(in srgb, var(--primary) 14%, transparent); }
  .picklist-menu li[aria-selected="true"] { font-weight: 500; }
  .picker > p { margin: 0; overflow-wrap: anywhere; }

  .virt-head { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
  .pickwrap.virt { border-style: dashed; }
  .ents .field { max-width: 440px; }
  .ulabels { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--tile); }
  .ugrid-wrap { overflow-x: auto; }
  .ugrid { display: grid; gap: 6px; min-width: min-content; }
  .ugrid input { min-width: 0; width: 100%; padding: 7px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); font-size: 14px; color: var(--fg); text-align: center; }
  .resettable { position: relative; display: block; }
  .resettable:has(.reset) input { padding-right: 40px; }
  .resettable .reset { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 6px; background: none; color: var(--muted); }
  .resettable .reset:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .resettable .reset svg { width: 18px; height: 18px; fill: currentColor; }

  summary { cursor: pointer; color: var(--muted); }
  li.entity { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 4px 0; }
  .eid { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .state { text-align: right; white-space: nowrap; }
`;
