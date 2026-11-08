/* The UI, inside the host's sandboxed frame. It has its own origin and no network, so all it can do is draw and send the
   host one of the few messages the host accepts. This first release only proves the frame, the host and HA talk. */
import { LitElement, css, html } from "lit";
import { type Theme, type Stored, readHostMessage } from "./messages";

declare const __VERSION__: string;

const APPEARANCES = [
  ["ha", "Home Assistant"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

let nextReq = 1;
const send = (msg: Record<string, unknown>) => parent.postMessage({ v: 1, ...msg }, "*");

/* Plain properties rather than decorators, so the same source builds under any compiler setting. */
export class EcApp extends LitElement {
  static properties = { stored: { state: true }, theme: { state: true } };
  declare private stored: Stored | null;
  declare private theme: Theme | null;

  constructor() {
    super();
    this.stored = null;
    this.theme = null;
  }

  static styles = css`
    :host { display: block; min-height: 100vh; box-sizing: border-box; padding: 24px 16px; font: 15px/1.5 Roboto, system-ui, sans-serif;
      background: var(--bg); color: var(--fg); }
    .card { max-width: 560px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 500; }
    p { margin: 0 0 12px; color: var(--muted); }
    label { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
    select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--primary); margin-right: 6px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.onMessage);
    send({ type: "ready" });
  }

  disconnectedCallback(): void {
    window.removeEventListener("message", this.onMessage);
    super.disconnectedCallback();
  }

  private onMessage = (e: MessageEvent): void => {
    if (e.source !== parent) return;
    const m = readHostMessage(e.data);
    if (!m) return;
    if (m.type === "init" || m.type === "config") this.stored = { revision: m.revision, zones: m.zones, devices: m.devices };
    if (m.type === "init" || m.type === "theme") this.applyTheme(m.theme);
  };

  private applyTheme(t: Theme): void {
    this.theme = t;
    const dark = t.mode === "dark";
    const base = dark
      ? { primary: "#03A9F4", bg: "#111111", card: "#1C1C1C", fg: "#E1E1E1", muted: "#9E9E9E", line: "#333333" }
      : { primary: "#03A9F4", bg: "#FAFAFA", card: "#FFFFFF", fg: "#212121", muted: "#727272", line: "#E0E0E0" };
    const colors = { ...base, ...t.colors };
    for (const [k, v] of Object.entries(colors)) this.style.setProperty(`--${k}`, v);
    document.documentElement.dataset.theme = t.mode;
    document.documentElement.style.colorScheme = t.mode;
  }

  private pick(e: Event): void {
    send({ type: "appearance", value: (e.target as HTMLSelectElement).value, req: nextReq++ });
  }

  render() {
    const zones = this.stored ? this.stored.zones.length : null;
    return html`<div class="card">
      <h1><span class="dot"></span>Environment Control</h1>
      <p>Installed, version ${__VERSION__}. Zones, readings and controls arrive in the next releases.</p>
      <p id="zones">${zones === null ? "Waiting for Home Assistant." : zones === 1 ? "1 zone stored." : `${zones} zones stored.`}</p>
      <label for="appearance"
        >Appearance
        <select id="appearance" @change=${this.pick}>
          ${APPEARANCES.map(([v, name]) => html`<option value=${v} ?selected=${this.theme?.appearance === v}>${name}</option>`)}
        </select></label
      >
    </div>`;
  }
}

if (!customElements.get("ec-app")) customElements.define("ec-app", EcApp);
