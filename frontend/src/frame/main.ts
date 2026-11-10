/* The UI, inside the host's sandboxed frame. It has its own origin and no network, so all it can do is draw and send the
   host one of the few messages the host accepts. Screens follow the design mock, rebuilt here: Overview, a tab per zone,
   Devices and Setup. Zones are set up in the releases that follow; this one draws what is stored and what HA has. */
import { LitElement, html, nothing } from "lit";
import { icon } from "./icons";
import {
  type Catalog,
  type CatalogDevice,
  type CatalogEntity,
  type LinkKind,
  type PathKind,
  type Stored,
  type Theme,
  readHostMessage,
} from "./messages";
import { type Device, type Zone, readDevices, readZones, stepsLeft } from "./model";
import { PALETTES, styles } from "./styles";

declare const __VERSION__: string;

type Screen = "overview" | "zone" | "devices" | "setup";
type Appearance = Theme["appearance"];

const APPEARANCES: [Appearance, "home" | "sun" | "moon", string][] = [
  ["ha", "home", "Home Assistant"],
  ["light", "sun", "Light"],
  ["dark", "moon", "Dark"],
];
const APPEARANCE_SAYS: Record<Appearance, string> = {
  ha: "Matching your Home Assistant theme, its colours and dark mode included, and following it when it changes.",
  light: "Light, whatever Home Assistant uses.",
  dark: "Dark, whatever Home Assistant uses.",
};
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
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* Plain properties rather than decorators, so the same source builds under any compiler setting. */
export class EcApp extends LitElement {
  static properties = {
    stored: { state: true },
    theme: { state: true },
    narrow: { state: true },
    catalog: { state: true },
    catalogError: { state: true },
    screen: { state: true },
    zoneId: { state: true },
  };
  static styles = styles;
  declare private stored: Stored | null;
  declare private theme: Theme | null;
  declare private narrow: boolean;
  declare private catalog: Catalog | null;
  declare private catalogError: string | null;
  declare private screen: Screen;
  declare private zoneId: string | null;
  private catalogReq = 0;

  constructor() {
    super();
    this.stored = null;
    this.theme = null;
    this.narrow = false;
    this.catalog = null;
    this.catalogError = null;
    this.screen = "overview";
    this.zoneId = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.onMessage);
    send({ type: "ready" });
  }

  disconnectedCallback(): void {
    window.removeEventListener("message", this.onMessage);
    super.disconnectedCallback();
  }

  private get zones(): Zone[] {
    return this.stored ? readZones(this.stored.zones) : [];
  }

  private get devices(): Device[] {
    return this.stored ? readDevices(this.stored.devices) : [];
  }

  private onMessage = (e: MessageEvent): void => {
    if (e.source !== parent) return;
    const m = readHostMessage(e.data);
    if (!m) return;
    if (m.type === "init" || m.type === "config") this.stored = { revision: m.revision, zones: m.zones, devices: m.devices };
    if (m.type === "init" || m.type === "theme") this.applyTheme(m.theme);
    if (m.type === "init" || m.type === "narrow") this.narrow = m.narrow;
    if (m.type === "init" && !this.catalog) this.askCatalog();
    if (m.type === "result" && m.req === this.catalogReq) {
      if (m.ok && m.catalog) [this.catalog, this.catalogError] = [m.catalog, null];
      else this.catalogError = m.error ?? "Home Assistant couldn't list its devices.";
    }
    /* A zone removed elsewhere takes its tab with it. */
    if (this.screen === "zone" && !this.zones.some((z) => z.id === this.zoneId)) this.go("overview");
  };

  private askCatalog(): void {
    this.catalogReq = nextReq++;
    this.catalogError = null;
    send({ type: "catalog", req: this.catalogReq });
  }

  private applyTheme(t: Theme): void {
    this.theme = t;
    const colors: Record<string, string> = { ...PALETTES[t.mode], ...t.colors };
    for (const [k, v] of Object.entries(colors)) this.style.setProperty(`--${k}`, v);
    document.documentElement.dataset.theme = t.mode;
    document.documentElement.style.colorScheme = t.mode;
  }

  private go(screen: Screen, zoneId: string | null = null): void {
    this.screen = screen;
    this.zoneId = zoneId;
    window.scrollTo(0, 0);
  }

  private chrome() {
    const tab = (label: string, screen: Screen, zoneId: string | null = null) => {
      const current = this.screen === screen && (screen !== "zone" || this.zoneId === zoneId);
      return html`<button aria-current=${current ? "page" : nothing} @click=${() => this.go(screen, zoneId)}>${label}</button>`;
    };
    return html`<header class="topbar">
      <div class="bar">
        ${this.narrow
          ? html`<button class="btn burger" aria-label="Open Home Assistant's sidebar" @click=${() => send({ type: "sidebar" })}>${icon("menu")}</button>`
          : nothing}
        <span>Environment Control</span>
      </div>
      <nav class="tabs" aria-label="Environment Control">
        ${tab("Overview", "overview")}${this.zones.map((z) => tab(z.name, "zone", z.id))}${tab("Devices", "devices")}${tab("Setup", "setup")}
      </nav>
    </header>`;
  }

  private overview() {
    if (!this.stored) return html`<p class="muted">Waiting for Home Assistant.</p>`;
    if (!this.zones.length)
      return html`<section class="card">
        <h2>No zones yet</h2>
        <p class="muted">A zone is a tent or room you grow in. Adding zones and mapping their sensors and devices from Home Assistant arrives in the next releases.</p>
      </section>`;
    return html`<div class="cards">
      ${this.zones.map(
        (z) => html`<button class="card zone-card" @click=${() => this.go("zone", z.id)}>
          <div class="card-head"><h2>${z.name}</h2>${stepsLeft(z).length ? html`<span class="pill warn">Not set up</span>` : nothing}</div>
          ${z.description ? html`<p class="small muted">${z.description}</p>` : nothing}
          <p class="small muted">${this.zoneCounts(z)}</p>
        </button>`,
      )}
    </div>`;
  }

  private zoneCounts(z: Zone): string {
    const devices = this.devices.filter((d) => d.zones.includes(z.id)).length;
    return `${plural(z.sensors.length, "sensor")}, ${plural(devices, "device")}. Readings arrive in a later release.`;
  }

  private zone() {
    const z = this.zones.find((x) => x.id === this.zoneId);
    if (!z) return nothing;
    return html`<div><h1>${z.name}</h1>${z.description ? html`<p class="muted">${z.description}</p>` : nothing}</div>
      <section class="card"><p class="muted">${this.zoneCounts(z)} Its map, readings, charts and controls arrive in the releases that follow.</p></section>`;
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
        ${chips.map((c) => html`<span class="pill ${c === LINK_LABEL.unknown || c === PATH_LABEL.unknown ? "dashed" : "plain"}">${c}</span>`)}
      </div>
      <details>
        <summary>${plural(d.entities.length, "entity", "entities")}</summary>
        <ul>${d.entities.map((e) => this.entityRow(e))}</ul>
      </details>
    </li>`;
  }

  private devicesScreen() {
    const head = html`<div>
      <h1>Devices</h1>
      <p class="muted small">
        What Home Assistant has, for Setup to pick from. How each device is connected is read from Home Assistant, and anything it
        can't tell says not known, so Setup can ask you. Nothing here changes anything.
      </p>
    </div>`;
    if (this.catalogError)
      return html`${head}<section class="card"><p>${this.catalogError}</p><div class="row"><button class="btn" @click=${this.askCatalog}>Try again</button></div></section>`;
    if (!this.catalog) return html`${head}<p class="muted">Asking Home Assistant.</p>`;
    const byArea = new Map<string, CatalogDevice[]>();
    for (const d of this.catalog.devices) byArea.set(d.area ?? "No area", [...(byArea.get(d.area ?? "No area") ?? []), d]);
    const loose = this.catalog.entities;
    return html`${head}
      <section class="card">
        <p class="small muted">${plural(this.catalog.devices.length, "device")} in Home Assistant.</p>
        ${[...byArea].map(([area, list]) => html`<h3>${area}</h3><ul>${list.map((d) => this.deviceRow(d))}</ul>`)}
        ${loose.length
          ? html`<h3>Belonging to no device</h3>
              <details>
                <summary>${loose.length === 1 ? "1 entity, such as a helper or template" : `${loose.length} entities, such as helpers and templates`}</summary>
                <ul>${loose.map((e) => this.entityRow(e))}</ul>
              </details>`
          : nothing}
      </section>`;
  }

  private setup() {
    const appearance = this.theme?.appearance ?? "ha";
    return html`<div>
        <h1>Setup</h1>
        <p class="muted small">Admins only. Installed, version ${__VERSION__}. Adding and setting up zones arrives in the next releases.</p>
      </div>
      <section class="card">
        <h2>Zones</h2>
        ${this.zones.length
          ? html`<div>
              ${this.zones.map(
                (z) => html`<div class="task">
                  <div>
                    <strong>${z.name}</strong>${stepsLeft(z).length ? html` <span class="pill warn">Not set up</span>` : nothing}
                    ${z.description ? html`<p class="small">${z.description}</p>` : nothing}
                    <p class="small muted">
                      ${z.layout ? `${z.layout.w} x ${z.layout.d} m, ${z.layout.units} units in ${z.layout.rows} rows. ` : ""}${z.sensors.filter((s) => s.placed).length} of
                      ${z.sensors.length} sensors placed.
                    </p>
                  </div>
                </div>`,
              )}
            </div>`
          : html`<p class="muted small">No zones yet.</p>`}
      </section>
      <section class="card" id="appearance">
        <div><h2>Appearance</h2><p class="small muted">${APPEARANCE_SAYS[appearance]}</p></div>
        <div class="looks" role="group" aria-label="Appearance">
          ${APPEARANCES.map(
            ([value, ico, label]) => html`<button class="look" aria-pressed=${appearance === value ? "true" : "false"} @click=${() => this.pickAppearance(value)}>
              ${icon(ico)}<span>${label}</span>
            </button>`,
          )}
        </div>
        <p class="small muted">Only on this device. Nothing changes in Home Assistant or in Environment Control's settings.</p>
      </section>`;
  }

  private pickAppearance(value: Appearance): void {
    send({ type: "appearance", value, req: nextReq++ });
  }

  render() {
    const screens: Record<Screen, () => unknown> = {
      overview: () => this.overview(),
      zone: () => this.zone(),
      devices: () => this.devicesScreen(),
      setup: () => this.setup(),
    };
    return html`${this.chrome()}<main><div class="wrap">${screens[this.screen]()}</div></main>`;
  }
}

if (!customElements.get("ec-app")) customElements.define("ec-app", EcApp);
