/* The UI, inside the host's sandboxed frame. It has its own origin and no network, so all it can do is draw and send the
   host one of the few messages the host accepts. So far it shows what is stored and what Home Assistant has, as the
   backend's catalog lists it, so the detected connections can be checked before Setup uses them. */
import { LitElement, css, html } from "lit";
import { type Catalog, type CatalogDevice, type CatalogEntity, type LinkKind, type PathKind, type Stored, type Theme, readHostMessage } from "./messages";

declare const __VERSION__: string;

const APPEARANCES = [
  ["ha", "Home Assistant"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

const LINK_LABEL: Record<LinkKind, string> = {
  ethernet: "Ethernet",
  wifi: "WiFi",
  zigbee: "Zigbee",
  zwave: "Z-Wave",
  thread: "Thread",
  bluetooth: "Bluetooth",
  derived: "Made from other entities",
  unknown: "Link not known",
};
const PATH_LABEL: Record<PathKind, string> = { local: "Local", cloud: "Cloud", derived: "", unknown: "Local or cloud not known" };

let nextReq = 1;
const send = (msg: Record<string, unknown>) => parent.postMessage({ v: 1, ...msg }, "*");

/* Plain properties rather than decorators, so the same source builds under any compiler setting. */
export class EcApp extends LitElement {
  static properties = { stored: { state: true }, theme: { state: true }, catalog: { state: true }, catalogError: { state: true } };
  declare private stored: Stored | null;
  declare private theme: Theme | null;
  declare private catalog: Catalog | null;
  declare private catalogError: string | null;
  private catalogReq = 0;

  constructor() {
    super();
    this.stored = null;
    this.theme = null;
    this.catalog = null;
    this.catalogError = null;
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
    .catalog { max-width: 720px; margin: 16px auto 0; }
    h2 { margin: 0 0 6px; font-size: 18px; font-weight: 500; }
    h3 { margin: 20px 0 6px; font-size: 13px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
    ul { list-style: none; margin: 0; padding: 0; }
    li.device { padding: 10px 0; border-top: 1px solid var(--line); }
    .name { font-weight: 500; overflow-wrap: anywhere; }
    .facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .chip { font-size: 12px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--line); color: var(--muted); }
    .chip.unknown { border-style: dashed; }
    details { margin-top: 6px; font-size: 13px; }
    summary { cursor: pointer; color: var(--muted); }
    li.entity { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 4px 0; }
    .eid { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .state { text-align: right; white-space: nowrap; }
    button { font: inherit; font-size: 14px; color: var(--primary); background: none; border: 1px solid var(--line); border-radius: 18px; padding: 6px 14px; cursor: pointer; }
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
    if (m.type === "init" && !this.catalog) this.askCatalog();
    if (m.type === "result" && m.req === this.catalogReq) {
      if (m.ok && m.catalog) [this.catalog, this.catalogError] = [m.catalog, null];
      else this.catalogError = m.error ?? "Home Assistant couldn't list its devices.";
    }
  };

  private askCatalog(): void {
    this.catalogReq = nextReq++;
    this.catalogError = null;
    send({ type: "catalog", req: this.catalogReq });
  }

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

  private entityRow(e: CatalogEntity) {
    const reading = e.state === null ? "" : e.unit ? `${e.state} ${e.unit}` : e.state;
    return html`<li class="entity">
      <span>${e.name}<br /><span class="eid">${e.entity_id}${e.device_class ? ` · ${e.device_class}` : ""}</span></span>
      <span class="state">${reading}</span>
    </li>`;
  }

  private deviceRow(d: CatalogDevice) {
    const chips = [d.family, LINK_LABEL[d.link], PATH_LABEL[d.path], d.hub ? `Through ${d.hub}` : ""].filter(Boolean);
    return html`<li class="device">
      <div class="name">${d.name}</div>
      <div class="facts">
        ${chips.map((c) => html`<span class="chip ${c === LINK_LABEL.unknown || c === PATH_LABEL.unknown ? "unknown" : ""}">${c}</span>`)}
      </div>
      <details>
        <summary>${d.entities.length === 1 ? "1 entity" : `${d.entities.length} entities`}</summary>
        <ul>${d.entities.map((e) => this.entityRow(e))}</ul>
      </details>
    </li>`;
  }

  private catalogCard() {
    if (this.catalogError) return html`<div class="card catalog"><h2>What Home Assistant has</h2><p>${this.catalogError}</p><button @click=${this.askCatalog}>Try again</button></div>`;
    if (!this.catalog) return html`<div class="card catalog"><h2>What Home Assistant has</h2><p>Asking Home Assistant.</p></div>`;
    const byArea = new Map<string, CatalogDevice[]>();
    for (const d of this.catalog.devices) byArea.set(d.area ?? "No area", [...(byArea.get(d.area ?? "No area") ?? []), d]);
    const loose = this.catalog.entities;
    return html`<div class="card catalog">
      <h2>What Home Assistant has</h2>
      <p>
        Setup will pick from these. How each device is connected is read from Home Assistant, and anything it can't tell
        says not known, so Setup can ask you. Nothing here changes anything.
      </p>
      <p>${this.catalog.devices.length === 1 ? "1 device" : `${this.catalog.devices.length} devices`}.</p>
      ${[...byArea].map(([area, list]) => html`<h3>${area}</h3><ul>${list.map((d) => this.deviceRow(d))}</ul>`)}
      ${loose.length
        ? html`<h3>Belonging to no device</h3>
            <details>
              <summary>${loose.length === 1 ? "1 entity, such as a helper or template" : `${loose.length} entities, such as helpers and templates`}</summary>
              <ul>${loose.map((e) => this.entityRow(e))}</ul>
            </details>`
        : ""}
    </div>`;
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
    </div>
    ${this.catalogCard()}`;
  }
}

if (!customElements.get("ec-app")) customElements.define("ec-app", EcApp);
