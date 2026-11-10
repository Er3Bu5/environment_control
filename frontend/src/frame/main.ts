/* The UI, inside the host's sandboxed frame. It has its own origin and no network, so all it can do is draw and send the
   host one of the few messages the host accepts. Screens follow the design mock, rebuilt here: Overview, a tab per zone,
   Devices and Setup, where zones are added, named, followed through their setup and removed. Editing only ever changes a
   draft; nothing is saved until it has been reviewed and applied, and leaving with a draft open asks first. */
import { LitElement, type PropertyValues, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { icon } from "./icons";
import {
  type Catalog,
  type CatalogDevice,
  type CatalogEntity,
  type HostMessage,
  type LinkKind,
  type PathKind,
  type Stored,
  type Theme,
  readHostMessage,
} from "./messages";
import {
  MAX_DESCRIPTION,
  MAX_ZONE_NAME,
  type RawConfig,
  SETUP_STEPS,
  STEP_TEXT,
  STEP_TITLE,
  type SetupStep,
  type Device,
  type Zone,
  addZone,
  copyConfig,
  markStep,
  readDevices,
  readZones,
  removeZone,
  confirmLink,
  setDetails,
  stepsLeft,
  unknownLinks,
  zoneNameIssue,
} from "./model";
import {
  type ControlCandidate,
  type Issue,
  type MapDraft,
  CLASSES,
  CLASS_SLOTS,
  type SensorClass,
  classSlots,
  METHODS,
  type Option,
  type Method,
  ROLES,
  type Role,
  SLOTS,
  SLOT_NAME,
  type SensorCandidate,
  type Slot,
  applyMap,
  controlCandidates,
  controlTarget,
  countedSensors,
  mapChanges,
  mapIssues,
  openMap,
  seedSlots,
  sensorCandidates,
  sensorTarget,
} from "./mapping";
import { PALETTES, styles } from "./styles";

declare const __VERSION__: string;

type Screen = "overview" | "zone" | "devices" | "setup";
type Appearance = Theme["appearance"];
type Result = Extract<HostMessage, { type: "result" }>;
interface Change {
  label: string;
  before: string;
  after: string;
}
/* Zone details: a new zone has no id until it's saved. fromGuide says where Cancel and Finish go back to. */
interface Wizard {
  id: string | null;
  name: string;
  desc: string;
  fromGuide: boolean;
}
interface Guard {
  kind: "guard";
  title: string;
  text: string;
  rows?: [string, string][];
  note?: string;
  confirm?: string;
  keep: string;
  go: string;
  action: () => void;
}
interface Review {
  kind: "review";
  changes: Change[];
  note: string;
  busy: boolean;
  error: string;
  apply: () => Promise<Result>;
  after: () => void;
}

/* Steps this release can open. The others say when they arrive rather than offering a button that does nothing. */
const BUILT: ReadonlySet<SetupStep> = new Set(["details", "devices"]);

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
    wiz: { state: true },
    mapw: { state: true },
    moreOpen: { state: true },
    guide: { state: true },
    modal: { state: true },
    menu: { state: true },
    toastText: { state: true },
    confirmText: { state: true },
  };
  static styles = styles;
  declare private stored: Stored | null;
  declare private theme: Theme | null;
  declare private narrow: boolean;
  declare private catalog: Catalog | null;
  declare private catalogError: string | null;
  declare private screen: Screen;
  declare private zoneId: string | null;
  declare private wiz: Wizard | null;
  declare private mapw: MapDraft | null;
  declare private moreOpen: Set<string>;
  private mapFromGuide = false;
  declare private guide: string | null;
  declare private modal: Guard | Review | null;
  declare private menu: string | null;
  declare private toastText: string;
  declare private confirmText: string;
  private nextReq = 1;
  private waiting = new Map<number, (r: Result) => void>();
  private draftHeld = false;
  private modalOpener: Element | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.stored = null;
    this.theme = null;
    this.narrow = false;
    this.catalog = null;
    this.catalogError = null;
    this.screen = "overview";
    this.zoneId = null;
    this.wiz = null;
    this.mapw = null;
    this.moreOpen = new Set();
    this.guide = null;
    this.modal = null;
    this.menu = null;
    this.toastText = "";
    this.confirmText = "";
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.onMessage);
    document.addEventListener("keydown", this.onKey);
    document.addEventListener("click", this.onOutsideClick);
    parent.postMessage({ v: 1, type: "ready" }, "*");
  }

  disconnectedCallback(): void {
    window.removeEventListener("message", this.onMessage);
    document.removeEventListener("keydown", this.onKey);
    document.removeEventListener("click", this.onOutsideClick);
    super.disconnectedCallback();
  }

  private get zones(): Zone[] {
    return this.stored ? readZones(this.stored.zones) : [];
  }

  private get devices(): Device[] {
    return this.stored ? readDevices(this.stored.devices) : [];
  }

  private zoneById(id: string | null): Zone | undefined {
    return this.zones.find((z) => z.id === id);
  }

  /* The frame's only way out. The host answers each request by number. */
  private ask(type: string, body: Record<string, unknown> = {}): Promise<Result> {
    const req = this.nextReq++;
    return new Promise((resolve) => {
      this.waiting.set(req, resolve);
      parent.postMessage({ v: 1, type, req, ...body }, "*");
    });
  }

  private onMessage = (e: MessageEvent): void => {
    if (e.source !== parent) return;
    const m = readHostMessage(e.data);
    if (!m) return;
    if (m.type === "init" || m.type === "config") this.stored = { revision: m.revision, zones: m.zones, devices: m.devices };
    if (m.type === "init" || m.type === "theme") this.applyTheme(m.theme);
    if (m.type === "init" || m.type === "narrow") this.narrow = m.narrow;
    if (m.type === "init" && !this.catalog) void this.askCatalog();
    if (m.type === "result") {
      const resolve = this.waiting.get(m.req);
      this.waiting.delete(m.req);
      resolve?.(m);
    }
    /* A zone removed elsewhere takes its tab, its guide and its open details with it. */
    if (this.screen === "zone" && !this.zoneById(this.zoneId)) this.go("overview");
    if (this.guide && !this.zoneById(this.guide)) this.guide = null;
    if (this.wiz?.id && !this.zoneById(this.wiz.id)) this.wiz = null;
    if (this.mapw && !this.zoneById(this.mapw.zoneId)) this.mapw = null;
  };

  private askCatalog = async (): Promise<void> => {
    this.catalogError = null;
    const r = await this.ask("catalog");
    if (r.ok && r.catalog) [this.catalog, this.catalogError] = [r.catalog, null];
    else this.catalogError = r.error ?? "Home Assistant couldn't list its devices.";
  };

  private applyTheme(t: Theme): void {
    this.theme = t;
    const colors: Record<string, string> = { ...PALETTES[t.mode], ...t.colors };
    for (const [k, v] of Object.entries(colors)) this.style.setProperty(`--${k}`, v);
    document.documentElement.dataset.theme = t.mode;
    document.documentElement.style.colorScheme = t.mode;
  }

  /* Saving: the change is made on a copy of what is stored, the host checks it and asks you about anything it would make
     controllable, and the backend stores it. Only the backend's answer is kept. */
  private async save(change: (c: RawConfig) => void): Promise<Result> {
    if (!this.stored) return { type: "result", req: 0, ok: false, error: "Home Assistant hasn't answered yet." };
    const c = copyConfig(this.stored.zones, this.stored.devices);
    change(c);
    const r = await this.ask("save", { base: this.stored.revision, config: c });
    if (r.ok && r.stored) this.stored = r.stored;
    return r;
  }

  private toast(text: string): void {
    this.toastText = text;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastText = ""), 2800);
  }

  /* Drafts. Zone details is the only one so far: what it would change, worked out against what's saved. */
  private wizChanges(w: Wizard): Change[] {
    const z = this.zoneById(w.id), out: Change[] = [];
    const add = (label: string, before: string, after: string) => before !== after && out.push({ label, before, after });
    add("Zone name", z ? z.name : "New zone", w.name.trim());
    add("Description", z?.description || "None", w.desc.trim() || "None");
    return out;
  }

  private get sensorsFound(): SensorCandidate[] {
    return this.catalog ? sensorCandidates(this.catalog) : [];
  }

  private get controlsFound(): ControlCandidate[] {
    return this.catalog ? controlCandidates(this.catalog) : [];
  }

  private get config() {
    return this.stored ? copyConfig(this.stored.zones, this.stored.devices) : { zones: [], devices: [] };
  }

  private mapChangeList(m: MapDraft): Change[] {
    return mapChanges(m, this.config, this.sensorsFound, this.controlsFound);
  }

  private get draftCount(): number {
    if (this.wiz) return this.wizChanges(this.wiz).length;
    if (this.mapw) return this.mapChangeList(this.mapw).length;
    return 0;
  }

  /* The frame can't raise the browser's leave prompt or stop HA's sidebar, so it tells the host whether leaving now would
     lose anything, and only when that changes. */
  protected updated(changed: PropertyValues): void {
    const held = this.draftCount > 0;
    if (held !== this.draftHeld) {
      this.draftHeld = held;
      parent.postMessage({ v: 1, type: "draft", open: held }, "*");
    }
    if (changed.has("modal")) {
      const before = changed.get("modal");
      if (this.modal && !before) {
        this.modalOpener = this.shadowRoot?.activeElement ?? null;
        (this.shadowRoot?.querySelector("#dlg-title") as HTMLElement | null)?.focus({ preventScroll: true });
      } else if (!this.modal && before && this.modalOpener instanceof HTMLElement && this.modalOpener.isConnected) {
        this.modalOpener.focus({ preventScroll: true });
      }
    }
  }

  /* Leaving drops a draft, so it asks first. */
  private guarded(action: () => void): void {
    const n = this.draftCount;
    if (!n) return action();
    const zone = (this.wiz && (this.zoneById(this.wiz.id)?.name ?? this.wiz.name.trim())) || (this.mapw && this.zoneById(this.mapw.zoneId)?.name) || "this zone";
    this.modal = {
      kind: "guard",
      title: "Discard unsaved changes?",
      text: `You have ${plural(n, "unsaved change")} in ${zone}. Leaving will discard ${n === 1 ? "it" : "them"}.`,
      keep: "Keep editing",
      go: "Discard and continue",
      action,
    };
  }

  private go(screen: Screen, zoneId: string | null = null): void {
    this.screen = screen;
    this.zoneId = zoneId;
    this.menu = null;
    window.scrollTo(0, 0);
  }

  private leaveTo(screen: Screen, zoneId: string | null = null): void {
    this.guarded(() => {
      this.wiz = null;
      this.mapw = null;
      this.guide = null;
      this.go(screen, zoneId);
    });
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (this.modal) {
      e.preventDefault();
      this.closeModal();
    } else if (this.menu) {
      const id = this.menu;
      this.menu = null;
      void this.updateComplete.then(() => (this.shadowRoot?.querySelector(`[data-zmenu="${id}"]`) as HTMLElement | null)?.focus());
    }
  };

  private onOutsideClick = (e: MouseEvent): void => {
    if (this.menu && !e.composedPath().some((n) => n instanceof HTMLElement && n.classList.contains("zmenu"))) this.menu = null;
  };

  private closeModal(): void {
    if (this.modal?.kind === "review" && this.modal.busy) return;
    this.modal = null;
    this.confirmText = "";
  }

  /* Zones: add, details, guide, remove. */
  private openNewZone = (): void => {
    this.guarded(() => {
      this.guide = null;
      this.mapw = null;
      this.wiz = { id: null, name: "", desc: "", fromGuide: false };
      this.go("setup");
    });
  };

  private openDetails(id: string, fromGuide = false): void {
    const z = this.zoneById(id);
    if (!z) return;
    this.wiz = { id, name: z.name, desc: z.description ?? "", fromGuide };
    this.menu = null;
    this.go("setup");
  }

  private cancelWizard = (): void => {
    this.guarded(() => {
      this.wiz = null;
    });
  };

  private finishWizard = (): void => {
    const w = this.wiz;
    if (!w || zoneNameIssue(w.name, this.zones, w.id)) return;
    const changes = this.wizChanges(w);
    if (changes.length) {
      let created = "";
      this.modal = {
        kind: "review",
        changes,
        note: w.id ? "This only changes Environment Control. Nothing in Home Assistant changes." : "It starts at 1.2 x 1.2 m with 4 units until you set its layout. Nothing in Home Assistant changes.",
        busy: false,
        error: "",
        apply: () =>
          this.save((c) => {
            if (w.id) {
              setDetails(c, w.id, w.name, w.desc);
              markStep(c, w.id, "details", "done");
            } else created = addZone(c, w.name, w.desc);
          }),
        after: () => {
          this.wiz = null;
          if (created) {
            this.guide = created;
            this.toast(`${w.name.trim()} created.`);
          } else {
            this.toast("Zone details saved.");
            if (!w.fromGuide) this.go("zone", w.id);
          }
        },
      };
      return;
    }
    /* Finish with nothing changed still confirms the step, which is how a step opened from the guide counts as done. */
    this.wiz = null;
    if (w.id && w.fromGuide) void this.mark(w.id, "details", "done");
  };

  private applyReview = async (): Promise<void> => {
    const r = this.modal;
    if (!r || r.kind !== "review" || r.busy) return;
    this.modal = { ...r, busy: true, error: "" };
    const result = await r.apply();
    if (!result.ok) {
      this.modal = { ...r, busy: false, error: result.error ?? "Not saved." };
      return;
    }
    this.modal = null;
    r.after();
  };

  private async mark(id: string, step: SetupStep, state: "done" | "later"): Promise<void> {
    const z = this.zoneById(id);
    if (!z || z.setup[step] === state || (state === "later" && z.setup[step] === "done")) return;
    const r = await this.save((c) => markStep(c, id, step, state));
    if (!r.ok) this.toast(`Not saved. ${r.error ?? ""}`.trim());
  }

  private openGuide(id: string): void {
    this.guarded(() => {
      this.wiz = null;
      this.mapw = null;
      this.guide = id;
      this.go("setup");
    });
  }

  /* Map devices: a draft of which sensors and devices a zone has, against the backend's catalog of what HA has. */
  private openMapDevices(id: string, fromGuide = false): void {
    this.guarded(() => {
      this.wiz = null;
      this.menu = null;
      this.mapw = openMap(this.config, id);
      this.mapFromGuide = fromGuide;
      if (!this.catalog) void this.askCatalog();
      this.go("setup");
    });
  }

  private setMap(change: (m: MapDraft) => void): void {
    if (!this.mapw) return;
    const m = structuredClone(this.mapw);
    change(m);
    this.mapw = m;
  }

  private toggleSensor(s: SensorCandidate): void {
    this.setMap((m) => {
      if (s.id in m.sensors) {
        delete m.sensors[s.id];
        delete m.cls[s.id];
      } else {
        m.cls[s.id] = s.detected;
        m.sensors[s.id] = seedSlots(s);
      }
    });
  }

  private toggleControl(c: ControlCandidate): void {
    this.setMap((m) => {
      if (c.entity in m.controls) delete m.controls[c.entity];
      else m.controls[c.entity] = c.detected;
    });
  }

  private async jumpTo(issue: Issue): Promise<void> {
    this.setMap((m) => (m.step = issue.step));
    await this.updateComplete;
    const el = this.shadowRoot?.querySelector(`#${issue.target}`) as HTMLElement | null;
    el?.scrollIntoView({ block: "center" });
    (el?.matches("input, button") ? el : (el?.querySelector("button, input") as HTMLElement | null))?.focus({ preventScroll: true });
  }

  private mapBack = (): void => {
    const m = this.mapw;
    if (!m) return;
    if (m.step > 1) {
      this.setMap((d) => (d.step = (d.step - 1) as 1 | 2));
      window.scrollTo(0, 0);
      return;
    }
    this.guarded(() => {
      this.mapw = null;
    });
  };

  private mapDone(zoneId: string): void {
    this.mapw = null;
    if (this.mapFromGuide) this.guide = zoneId;
    else this.go("zone", zoneId);
  }

  private mapNext = (): void => {
    const m = this.mapw;
    if (!m) return;
    const sensors = this.sensorsFound, controls = this.controlsFound, issues = mapIssues(m, sensors, controls);
    if (m.step < 3) {
      const here = issues.find((i) => i.step === m.step);
      if (here) return void this.jumpTo(here);
      this.setMap((d) => (d.step = (d.step + 1) as 2 | 3));
      window.scrollTo(0, 0);
      return;
    }
    if (issues.length) return void this.jumpTo(issues[0]);
    const changes = this.mapChangeList(m);
    if (!changes.length) {
      void this.mark(m.zoneId, "devices", "done");
      this.mapDone(m.zoneId);
      return;
    }
    const added = Object.keys(m.controls).filter((e) => !this.devices.some((d) => d.zones.length && this.storedEntity(d.id) === e)).length;
    this.modal = {
      kind: "review",
      changes,
      note: `This only changes Environment Control. Nothing in Home Assistant changes.${added ? " Home Assistant asks you before any device becomes controllable." : ""}`,
      busy: false,
      error: "",
      apply: () =>
        this.save((c) => {
          applyMap(c, m, sensors, controls);
          markStep(c, m.zoneId, "devices", "done");
        }),
      after: () => {
        this.toast("Mapping saved.");
        this.mapDone(m.zoneId);
      },
    };
  };

  private storedEntity(deviceId: string): string | undefined {
    const raw = this.stored?.devices.find((d) => typeof d === "object" && d !== null && (d as { id?: unknown }).id === deviceId) as { entity?: unknown } | undefined;
    return typeof raw?.entity === "string" ? raw.entity : undefined;
  }

  private async answerLink(id: string, link: "ethernet" | "wifi"): Promise<void> {
    const r = await this.save((c) => confirmLink(c, id, link));
    this.toast(r.ok ? "Saved." : `Not saved. ${r.error ?? ""}`.trim());
  }

  private askRemove(id: string): void {
    const z = this.zoneById(id);
    if (!z) return;
    this.menu = null;
    const inZone = this.devices.filter((d) => d.zones.includes(id));
    const alone = inZone.filter((d) => d.zones.length === 1), shared = inZone.filter((d) => d.zones.length > 1);
    const others = this.zones.filter((o) => o.id !== id && shared.some((d) => d.zones.includes(o.id))).map((o) => o.name).join(" and ");
    const devicesWord = [alone.length ? `${alone.length} unmapped` : "", shared.length ? `${shared.length} stay in ${others}` : ""].filter(Boolean).join(", ");
    const rows: [string, string][] = [
      ["Placement", z.layout ? `${z.layout.w} x ${z.layout.d} m, ${plural(z.layout.units, "unit")}` : ""],
      ["Sensors", z.sensors.length ? `${z.sensors.length} unmapped` : ""],
      ["Devices", devicesWord],
      ["Targets", "Day and night values kept here"],
    ];
    this.confirmText = "";
    this.modal = {
      kind: "guard",
      title: `Remove ${z.name}?`,
      text: "This removes the zone from Environment Control and can't be undone. Nothing in Home Assistant changes.",
      rows: rows.filter(([, text]) => text),
      note: "Its sensors and devices can be mapped to another zone. Anything set on a board stays there. Getting this zone back means setting it up again.",
      confirm: z.name,
      keep: "Keep zone",
      go: "Remove zone",
      action: () => void this.removeNow(id, z.name),
    };
  }

  private async removeNow(id: string, name: string): Promise<void> {
    const r = await this.save((c) => removeZone(c, id));
    if (!r.ok) {
      this.toast(`${name} wasn't removed. ${r.error ?? ""}`.trim());
      return;
    }
    if (this.guide === id) this.guide = null;
    if (this.zoneId === id) this.go("setup");
    this.toast(`${name} removed.`);
  }

  private guardGo = (): void => {
    const g = this.modal;
    if (!g || g.kind !== "guard" || (g.confirm && this.confirmText !== g.confirm)) return;
    this.modal = null;
    this.confirmText = "";
    g.action();
  };

  /* Drawing. */
  private chrome() {
    const tab = (label: string, screen: Screen, zoneId: string | null = null) => {
      const current = this.screen === screen && (screen !== "zone" || this.zoneId === zoneId);
      return html`<button aria-current=${current ? "page" : nothing} @click=${() => this.leaveTo(screen, zoneId)}>${label}</button>`;
    };
    return html`<header class="topbar" ?inert=${!!this.modal}>
      <div class="bar">
        ${this.narrow
          ? html`<button class="btn burger" aria-label="Open Home Assistant's sidebar" @click=${() => parent.postMessage({ v: 1, type: "sidebar" }, "*")}>${icon("menu")}</button>`
          : nothing}
        <span>Environment Control</span>
      </div>
      <nav class="tabs" aria-label="Environment Control">
        ${tab("Overview", "overview")}${this.zones.map((z) => tab(z.name, "zone", z.id))}${tab("Devices", "devices")}${tab("Setup", "setup")}
      </nav>
    </header>`;
  }

  private addButton(label: string) {
    return html`<button class="btn primary add" @click=${this.openNewZone}>${icon("plus")}${label}</button>`;
  }

  private overview() {
    if (!this.stored) return html`<p class="muted">Waiting for Home Assistant.</p>`;
    if (!this.zones.length)
      return html`<section class="card">
        <h2>No zones yet</h2>
        <p class="muted">Add a zone, then map its sensors and devices from Home Assistant.</p>
        <div class="row">${this.addButton("Add a zone")}</div>
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
    const z = this.zoneById(this.zoneId);
    if (!z) return nothing;
    const left = stepsLeft(z);
    return html`<div><h1>${z.name}</h1>${z.description ? html`<p class="muted">${z.description}</p>` : nothing}</div>
      ${left.length
        ? html`<button class="notice fix" @click=${() => this.openGuide(z.id)}>
            <span>Not set up yet. Still to confirm: ${left.map((k) => STEP_TITLE[k]).join(", ")}.</span><span class="fixgo">Continue setup &rsaquo;</span>
          </button>`
        : nothing}
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

  private wizard(w: Wizard) {
    const issue = zoneNameIssue(w.name, this.zones, w.id), typed = !!w.name.trim();
    const changes = this.wizChanges(w).length;
    return html`<div><h1>${w.id ? "Zone details" : "Add zone"}</h1></div>
      <section class="card">
        <label class="field" for="wiz-name"
          >Zone name<input
            id="wiz-name"
            type="text"
            maxlength=${MAX_ZONE_NAME}
            enterkeyhint="next"
            autocomplete="off"
            .value=${w.name}
            aria-invalid=${issue && typed ? "true" : "false"}
            @input=${(e: Event) => (this.wiz = { ...w, name: (e.target as HTMLInputElement).value })}
            @keydown=${(e: KeyboardEvent) => e.key === "Enter" && (this.shadowRoot?.querySelector("#wiz-desc") as HTMLElement | null)?.focus()}
        /></label>
        <label class="field" for="wiz-desc"
          >Description, optional<textarea
            id="wiz-desc"
            rows="3"
            maxlength=${MAX_DESCRIPTION}
            enterkeyhint="done"
            placeholder="For example Flowering tent by the window"
            .value=${w.desc}
            @input=${(e: Event) => (this.wiz = { ...w, desc: (e.target as HTMLTextAreaElement).value })}
          ></textarea></label>
        ${w.id ? nothing : html`<p class="small muted">Size and units come later, after its devices are mapped.</p>`}
        <div class="row">
          <button class="btn" @click=${this.cancelWizard}>Cancel</button>
          <button class="btn primary" ?disabled=${!!issue} @click=${this.finishWizard}>${changes ? "Review and apply" : "Finish"}</button>
          <button class="fixlink" ?hidden=${!issue} @click=${() => (this.shadowRoot?.querySelector("#wiz-name") as HTMLElement | null)?.focus()}>${issue} &rsaquo;</button>
        </div>
      </section>`;
  }

  private guideScreen(id: string) {
    const z = this.zoneById(id);
    if (!z) return nothing;
    const next = SETUP_STEPS.find((k) => BUILT.has(k) && z.setup[k] !== "done");
    return html`<div>
        <h1>Set up ${z.name}</h1>
        <p class="muted small">
          ${z.name} is saved, with everything at 0 and marked not set up. Each step counts as done once you've been through it and confirmed it, even if you
          change nothing. Any step can wait: what's left shows on Setup and on its page.
        </p>
      </div>
      <section class="card">
        <div>
          ${SETUP_STEPS.map((k, i) => {
            const state = z.setup[k], built = BUILT.has(k);
            const pill =
              state === "done" ? html`<span class="pill ok">Done</span>` : !built ? html`<span class="pill dashed">In a later release</span>` : state === "later" ? html`<span class="pill plain">Later</span>` : nothing;
            return html`<div class="task" id="g-${k}" aria-current=${k === next ? "step" : nothing}>
              <div><strong>${i + 1}. ${STEP_TITLE[k]}</strong><p class="small muted">${STEP_TEXT[k]}</p></div>
              <div class="row">
                ${pill}
                ${built
                  ? html`<button class="btn ${k === next ? "primary" : ""}" @click=${() => (k === "details" ? this.openDetails(z.id, true) : this.openMapDevices(z.id, true))}>${STEP_TITLE[k]}</button>`
                  : nothing}
                ${built && state === "todo" ? html`<button class="btn" @click=${() => this.mark(z.id, k, "later")}>Later</button>` : nothing}
              </div>
            </div>`;
          })}
        </div>
        <div class="row"><button class="btn" @click=${() => this.leaveTo("zone", z.id)}>${stepsLeft(z).length ? "Finish for now" : "Done"}</button></div>
      </section>`;
  }

  private chips(legend: string, name: string, options: { value: string; label: string; wait?: boolean }[], current: string, pick: (v: string) => void) {
    return html`<fieldset class="chips">
      <legend>${legend}</legend>
      <div class="chiprow">
        ${options.map(
          (o) => html`<label class="chip ${o.wait ? "wait" : ""}"
            ><input type="radio" name=${name} .value=${o.value} .checked=${live(current === o.value)} @change=${() => pick(o.value)} />${o.label}</label
          >`,
        )}
      </div>
    </fieldset>`;
  }

  /* A reading offers what HA's device classes suggest, Not used, and then, on request, every other sensor on the device,
     so any of them can be put to any reading. A pick from that list stays in view once it closes. */
  private slotChoice(m: MapDraft, s: SensorCandidate, k: Slot) {
    const cur = m.sensors[s.id][k], key = `${s.id}:${k}`, open = this.moreOpen.has(key);
    const label = (o: Option) => `${o.name}, ${o.reading}`;
    const shown = [...s.slots[k]];
    const picked = s.all.find((o) => o.entity === cur);
    if (picked && !shown.some((o) => o.entity === cur)) shown.push(picked);
    const more = s.all.filter((o) => !shown.some((x) => x.entity === o.entity));
    const options = [...shown.map((o) => ({ value: o.entity, label: label(o) })), { value: "none", label: "Not used" }];
    if (open) options.push(...more.map((o) => ({ value: o.entity, label: label(o) })));
    return html`${this.chips(`${SLOT_NAME[k]}${cur === "" ? ", pick one" : ""}`, `${s.id}-${k}`, options, cur, (v) => {
        this.setMap((d) => (d.sensors[s.id][k] = v));
        this.toggleMore(key, false);
      })}
      ${more.length
        ? html`<button class="fixlink small" aria-expanded=${open ? "true" : "false"} @click=${() => this.toggleMore(key, !open)}>
            ${open ? "Fewer" : `From this device: ${plural(more.length, "more sensor")}`} &rsaquo;
          </button>`
        : nothing}`;
  }

  private toggleMore(key: string, open: boolean): void {
    const next = new Set(this.moreOpen);
    if (open) next.add(key);
    else next.delete(key);
    this.moreOpen = next;
  }

  private nearZone(z: Zone, area: string | null): boolean {
    return !!area && area.toLowerCase() === z.name.toLowerCase();
  }

  private setClass(s: SensorCandidate, cls: SensorClass): void {
    this.setMap((m) => {
      m.cls[s.id] = cls;
      m.sensors[s.id] = seedSlots(s, cls, m.sensors[s.id]);
    });
  }

  private sensorRow(m: MapDraft, z: Zone, s: SensorCandidate) {
    const on = s.id in m.sensors, cls = m.cls[s.id] ?? s.detected, waiting = on && classSlots(m, s.id).some((k) => m.sensors[s.id][k] === "");
    const elsewhere = this.zones.filter((o) => o.id !== z.id && o.sensors.some((x) => x.id === s.id)).map((o) => o.name);
    const pill = waiting
      ? html`<span class="pill high">Pick one</span>`
      : this.nearZone(z, s.area)
        ? html`<span class="pill plain">Suggested</span>`
        : elsewhere.length
          ? html`<span class="pill plain">In ${elsewhere[0]}</span>`
          : nothing;
    const has = CLASS_SLOTS[s.detected].filter((k) => s.slots[k].length).map((k) => SLOT_NAME[k]).join(", ");
    return html`<div class="pickwrap" id=${sensorTarget(s.id)}>
      <button class="pickrow" aria-pressed=${on ? "true" : "false"} @click=${() => this.toggleSensor(s)}>
        <span class="tick">${on ? "✓" : ""}</span>
        <span class="pick-text"><strong>${s.name}</strong><span class="dev-sub">${s.family}, ${LINK_LABEL[s.link]}. ${CLASSES[s.detected]}: ${has}</span></span>${pill}
      </button>
      ${on
        ? html`<div class="ents">
            ${this.chips(
              "Class",
              `class-${s.id}`,
              (Object.keys(CLASSES) as SensorClass[]).map((k) => ({ value: k, label: k === s.detected ? `${CLASSES[k]}, detected` : CLASSES[k] })),
              cls,
              (v) => this.setClass(s, v as SensorClass),
            )}
            ${repeat(CLASS_SLOTS[cls], (k) => k, (k) => this.slotChoice(m, s, k))}
            <label class="inavg"
              ><input type="checkbox" .checked=${m.avg[s.id] === false} @change=${(e: Event) => this.setMap((d) => (d.avg[s.id] = !(e.target as HTMLInputElement).checked))} />
              Exclude from average</label
            >
          </div>`
        : nothing}
    </div>`;
  }

  private controlRow(m: MapDraft, z: Zone, c: ControlCandidate) {
    const on = c.entity in m.controls, role = m.controls[c.entity] ?? "";
    const others = this.devices.filter((d) => this.storedEntity(d.id) === c.entity).flatMap((d) => d.zones).filter((id) => id !== z.id);
    const otherNames = this.zones.filter((o) => others.includes(o.id)).map((o) => o.name);
    const pill = on && !role ? html`<span class="pill high">What is it?</span>` : this.nearZone(z, c.area) ? html`<span class="pill plain">Suggested</span>` : nothing;
    return html`<div class="pickwrap" id=${controlTarget(c.entity)}>
      <button class="pickrow" aria-pressed=${on ? "true" : "false"} @click=${() => this.toggleControl(c)}>
        <span class="tick">${on ? "✓" : ""}</span>
        <span class="pick-text"><strong>${c.name}</strong><span class="dev-sub">${c.family}, ${LINK_LABEL[c.link]}. ${c.entity}</span></span>${pill}
      </button>
      ${on
        ? html`<div class="ents">
            ${this.chips(
              role ? "This is a" : "This is a, pick one",
              `role-${c.entity}`,
              ROLES.map((r) => ({ value: r, label: r })),
              role,
              (v) => this.setMap((d) => (d.controls[c.entity] = v as Role)),
            )}
            ${otherNames.length ? html`<p class="dev-sub">Shared. Also in ${otherNames.join(", ")}.</p>` : nothing}
          </div>`
        : nothing}
    </div>`;
  }

  private mapList<T>(items: T[], near: (x: T) => boolean, row: (x: T) => unknown, empty: string) {
    if (!items.length) return html`<p class="small muted">${empty}</p>`;
    const close = items.filter(near), rest = items.filter((x) => !near(x));
    return html`${close.map(row)}${rest.length ? html`<p class="small muted">${close.length ? "Everything else in Home Assistant" : "Everything in Home Assistant"}</p>${rest.map(row)}` : nothing}`;
  }

  private mapWizard(m: MapDraft) {
    const z = this.zoneById(m.zoneId);
    if (!z) return nothing;
    const steps = html`<ol class="steps">
      ${["Sensors", "Devices", "Check"].map((n, i) => html`<li aria-current=${m.step === i + 1 ? "step" : nothing}>${i + 1}. ${n}</li>`)}
    </ol>`;
    const head = html`<div><h1>Map devices: ${z.name}</h1></div>`;
    if (!this.catalog)
      return html`${head}<section class="card">
          ${steps}${this.catalogError
            ? html`<p>${this.catalogError}</p>
                <div class="row"><button class="btn" @click=${this.askCatalog}>Try again</button></div>`
            : html`<p class="muted">Asking Home Assistant what it has.</p>`}
          <div class="row"><button class="btn" @click=${this.mapBack}>Cancel</button></div>
        </section>`;
    const sensors = this.sensorsFound, controls = this.controlsFound, issues = mapIssues(m, sensors, controls);
    const here = issues.filter((i) => i.step === m.step), blocked = m.step === 3 ? issues.length > 0 : here.length > 0;
    const q = m.q.trim().toLowerCase(), hit = (t: string) => !q || t.toLowerCase().includes(q);
    const search = html`<label class="field" for="map-q"
      >Search Home Assistant<input
        id="map-q"
        type="search"
        placeholder="Name, entity or integration"
        .value=${m.q}
        @input=${(e: Event) => this.setMap((d) => (d.q = (e.target as HTMLInputElement).value))}
    /></label>`;
    let body: unknown = nothing;
    if (m.step === 1) {
      const shown = sensors.filter((s) => hit(`${s.name} ${s.family} ${SLOTS.flatMap((k) => s.slots[k].map((o) => o.entity)).join(" ")}`));
      const gone = Object.keys(m.sensors).filter((id) => !sensors.some((s) => s.id === id));
      const combine = (Object.keys(CLASSES) as SensorClass[]).map((cls) => [cls, countedSensors(m, cls)] as const).filter(([, n]) => n >= 2);
      body = html`<p class="muted">
          Pick the sensors in ${z.name}. Each one is a physical device. Its readings are suggested by what Home Assistant says each entity measures, and any
          sensor on the device can be put to any reading.
        </p>
        ${search}
        <div class="picklist">
          ${gone.map(
            (id) => html`<div class="pickwrap" id=${sensorTarget(id)}>
              <button class="pickrow" aria-pressed="true" @click=${() => this.setMap((d) => delete d.sensors[id])}>
                <span class="tick">✓</span><span class="pick-text"><strong>${id}</strong><span class="dev-sub">Mapped, but Home Assistant no longer has it.</span></span
                ><span class="pill dashed">Not in Home Assistant</span>
              </button>
            </div>`,
          )}
          ${this.mapList(shown, (s) => this.nearZone(z, s.area) || s.id in m.sensors, (s) => this.sensorRow(m, z, s), q ? "Nothing matches that search." : "Home Assistant has no sensors to map.")}
        </div>
        ${combine.map(
          ([cls, n]) => html`<div class="combine">
            ${this.chips(
              `How should these ${n} ${CLASSES[cls].toLowerCase()} sensors combine into the zone's reading?`,
              `combine-${cls}`,
              Object.entries(METHODS).map(([value, label]) => ({ value, label })),
              m.combine[cls],
              (v) => this.setMap((d) => (d.combine[cls] = v as Method)),
            )}
          </div>`,
        )}`;
    }
    if (m.step === 2) {
      const shown = controls.filter((c) => hit(`${c.name} ${c.family} ${c.entity}`));
      const gone = Object.keys(m.controls).filter((e) => !controls.some((c) => c.entity === e));
      body = html`<p class="muted">Pick what runs in ${z.name}: climate hardware and lights. Shared hardware can be in several zones.</p>
        ${search}
        <div class="picklist">
          ${gone.map(
            (e) => html`<div class="pickwrap" id=${controlTarget(e)}>
              <button class="pickrow" aria-pressed="true" @click=${() => this.setMap((d) => delete d.controls[e])}>
                <span class="tick">✓</span><span class="pick-text"><strong>${e}</strong><span class="dev-sub">Mapped, but Home Assistant no longer has it.</span></span
                ><span class="pill dashed">Not in Home Assistant</span>
              </button>
            </div>`,
          )}
          ${this.mapList(shown, (c) => this.nearZone(z, c.area) || c.entity in m.controls, (c) => this.controlRow(m, z, c), q ? "Nothing matches that search." : "Home Assistant has no switches, lights, fans or humidifiers.")}
        </div>`;
    }
    if (m.step === 3) {
      const ss = Object.keys(m.sensors).map((id) => `${sensors.find((s) => s.id === id)?.name ?? id} (${CLASSES[m.cls[id] ?? "env"].toLowerCase()})`);
      const cs = Object.entries(m.controls).map(([e, role]) => `${controls.find((c) => c.entity === e)?.name ?? e} (${role || "not set"})`);
      body = html`<div class="review">
          <div><strong>${plural(ss.length, "sensor")}</strong><p class="small muted">${ss.join(", ") || "None"}</p></div>
          <div><strong>${plural(cs.length, "device")}</strong><p class="small muted">${cs.join(", ") || "None"}</p></div>
        </div>
        ${issues.map((i) => html`<button class="notice fix" @click=${() => this.jumpTo(i)}><span>${i.text}</span><span class="fixgo">Fix &rsaquo;</span></button>`)}
        <p class="small muted">Applying only changes Environment Control. Home Assistant asks you before any device becomes controllable.</p>`;
    }
    const last = m.step === 3, changes = last ? this.mapChangeList(m).length : 0;
    return html`${head}<section class="card">
        ${steps}${body}
        <div class="row">
          <button class="btn" @click=${this.mapBack}>${m.step === 1 ? "Cancel" : "Back"}</button>
          <button class="btn primary" ?disabled=${blocked} @click=${this.mapNext}>${last ? (changes ? "Review and apply" : "Finish") : "Next"}</button>
          ${here.length ? html`<button class="fixlink" @click=${() => this.jumpTo(here[0])}>${here[0].text} &rsaquo;</button>` : nothing}
        </div>
      </section>`;
  }

  private questions() {
    const asks = unknownLinks(this.config);
    if (!asks.length) return nothing;
    return html`<section class="card">
      <h2>Questions for you</h2>
      <div>
        ${asks.map(
          (a) => html`<div class="task">
            <div>
              <strong>${a.name}</strong>
              <p class="small muted">Home Assistant doesn't say whether this ${a.kind === "sensor" ? "board" : "device"} is wired or on WiFi. How is it connected?</p>
            </div>
            <div class="row">
              <button class="btn" @click=${() => this.answerLink(a.id, "ethernet")}>Ethernet</button><button class="btn" @click=${() => this.answerLink(a.id, "wifi")}>WiFi</button>
            </div>
          </div>`,
        )}
      </div>
    </section>`;
  }

  private zoneRow(z: Zone) {
    const open = this.menu === z.id;
    return html`<div class="task">
      <div>
        <strong>${z.name}</strong>${stepsLeft(z).length ? html` <span class="pill warn">Not set up</span>` : nothing}
        ${z.description ? html`<p class="small">${z.description}</p>` : nothing}
        <p class="small muted">
          ${z.layout ? `${z.layout.w} x ${z.layout.d} m, ${plural(z.layout.units, "unit")} in ${plural(z.layout.rows, "row")}. ` : ""}${z.sensors.filter((s) => s.placed).length}
          of ${plural(z.sensors.length, "sensor")} placed.
        </p>
      </div>
      <div class="row zacts">
        ${stepsLeft(z).length ? html`<button class="btn primary" @click=${() => this.openGuide(z.id)}>Continue setup</button>` : nothing}
        <div class="zmenu">
          <button
            class="btn burger"
            data-zmenu=${z.id}
            aria-haspopup="menu"
            aria-expanded=${open ? "true" : "false"}
            aria-controls="zmenu-${z.id}"
            aria-label="Set up ${z.name}"
            @click=${() => this.toggleMenu(z.id)}
          >
            ${icon("menu")}
          </button>
          <div class="menu" id="zmenu-${z.id}" role="menu" ?hidden=${!open}>
            <button role="menuitem" @click=${() => this.openDetails(z.id)}>Zone details</button>
            <button role="menuitem" @click=${() => this.openMapDevices(z.id)}>Map devices</button>
            <hr />
            <button role="menuitem" class="remove" @click=${() => this.askRemove(z.id)}>Remove zone</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  private toggleMenu(id: string): void {
    this.menu = this.menu === id ? null : id;
    if (this.menu) void this.updateComplete.then(() => (this.shadowRoot?.querySelector(`#zmenu-${id} [role="menuitem"]`) as HTMLElement | null)?.focus());
  }

  private setup() {
    if (this.wiz) return this.wizard(this.wiz);
    if (this.mapw) return this.mapWizard(this.mapw);
    if (this.guide) return this.guideScreen(this.guide);
    const appearance = this.theme?.appearance ?? "ha";
    return html`<div>
        <h1>Setup</h1>
        <p class="muted small">Admins only. Installed, version ${__VERSION__}. Changes here are saved in Environment Control.</p>
      </div>
      ${this.questions()}
      <section class="card">
        <div class="card-head"><h2>Zones</h2>${this.addButton("Add zone")}</div>
        ${this.zones.length ? html`<div>${this.zones.map((z) => this.zoneRow(z))}</div>` : html`<p class="muted small">No zones yet.</p>`}
      </section>
      <section class="card" id="appearance">
        <div><h2>Appearance</h2><p class="small muted">${APPEARANCE_SAYS[appearance]}</p></div>
        <div class="looks" role="group" aria-label="Appearance">
          ${APPEARANCES.map(
            ([value, ico, label]) => html`<button class="look" aria-pressed=${appearance === value ? "true" : "false"} @click=${() => void this.ask("appearance", { value })}>
              ${icon(ico)}<span>${label}</span>
            </button>`,
          )}
        </div>
        <p class="small muted">Only on this device. Nothing changes in Home Assistant or in Environment Control's settings.</p>
      </section>`;
  }

  private modalView() {
    const m = this.modal;
    if (!m) return nothing;
    if (m.kind === "guard") {
      const blocked = !!m.confirm && this.confirmText !== m.confirm;
      return html`<div class="modal">
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-text">
          <h2 id="dlg-title" tabindex="-1">${m.title}</h2>
          <p class="muted" id="dlg-text">${m.text}</p>
          ${m.rows?.length
            ? html`<div class="review-scroll">
                <div class="review-list">${m.rows.map(([label, text]) => html`<div class="review-row"><strong>${label}</strong><span>${text}</span></div>`)}</div>
                ${m.note ? html`<p class="small muted">${m.note}</p>` : nothing}
              </div>`
            : nothing}
          ${m.confirm
            ? html`<label class="field" for="dlg-confirm"
                >Type ${m.confirm} to confirm<input
                  id="dlg-confirm"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  enterkeyhint="done"
                  .value=${this.confirmText}
                  @input=${(e: Event) => (this.confirmText = (e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.guardGo()}
              /></label>`
            : nothing}
          <div class="row">
            <button class="btn" @click=${() => this.closeModal()}>${m.keep}</button>
            <button class="btn danger" ?disabled=${blocked} @click=${this.guardGo}>${m.go}</button>
          </div>
        </div>
      </div>`;
    }
    const n = m.changes.length;
    return html`<div class="modal">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-text">
        <h2 id="dlg-title" tabindex="-1">Review changes</h2>
        <p class="muted small" id="dlg-text">Confirm each value before applying.</p>
        <div class="review-scroll">
          <div class="review-list">
            ${m.changes.map(
              (c) => html`<div class="review-row"><strong>${c.label}</strong><span>${c.before} <span aria-hidden="true">&rarr;</span> <b>${c.after}</b></span></div>`,
            )}
          </div>
          ${m.note ? html`<p class="small muted">${m.note}</p>` : nothing}
          ${m.error ? html`<div class="notice" role="alert"><strong>Not saved.</strong><span>${m.error}</span></div>` : nothing}
        </div>
        <div class="row">
          <button class="btn" ?disabled=${m.busy} @click=${() => this.closeModal()}>Back to editing</button>
          <button class="btn primary" ?disabled=${m.busy} @click=${this.applyReview}>${m.busy ? "Saving..." : `Apply ${plural(n, "change")}`}</button>
        </div>
      </div>
    </div>`;
  }

  render() {
    const screens: Record<Screen, () => unknown> = {
      overview: () => this.overview(),
      zone: () => this.zone(),
      devices: () => this.devicesScreen(),
      setup: () => this.setup(),
    };
    return html`${this.chrome()}<main ?inert=${!!this.modal}><div class="wrap">${screens[this.screen]()}</div></main>
      ${this.modalView()}${this.toastText ? html`<div class="toast" role="status" aria-live="polite">${this.toastText}</div>` : nothing}`;
  }
}

if (!customElements.get("ec-app")) customElements.define("ec-app", EcApp);
