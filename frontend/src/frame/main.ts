/* The UI, inside the host's sandboxed frame. It has its own origin and no network, so all it can do is draw and send the
   host one of the few messages the host accepts. Screens follow the design mock, rebuilt here: Overview, a tab per zone,
   Devices and Setup, where zones are added, named, followed through their setup and removed. Editing only ever changes a
   draft; nothing is saved until it has been reviewed and applied, and leaving with a draft open asks first. */
import { LitElement, type PropertyValues, html, nothing, svg, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { icon } from "./icons";
import {
  type Catalog,
  type CatalogDevice,
  type CatalogEntity,
  type History,
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
import {
  type Item,
  type LayoutDraft,
  LEVELS,
  type Level,
  type Spot,
  addVirtual,
  applyLayout,
  devsOff,
  firstToPlace,
  fits,
  flowOf,
  itemOf,
  layoutChanges,
  layoutIssues,
  onMapOnly,
  openLayout,
  posText,
  storedLayout,
  stranded,
  suggestGrid,
  typed,
  zoneItems,
  MAX_GRID,
} from "./layout";
import { keyView, look, mapView, mk } from "./map-view";
import {
  BAND_WORDS,
  type BandState,
  type HaState,
  METRIC,
  type Metric,
  type SensorReading,
  type ZoneReading,
  ago,
  bandState,
  bandsOf,
  fmt,
  healthOf,
  isDay,
  leafOf,
  numberOf,
  readSensor,
  readState,
  sensorsOf,
  zoneReading,
} from "./readings";
import { PALETTES, styles } from "./styles";
import {
  KEPT,
  LEAF_GIVE_UP_MS,
  type Home,
  type LeafDraft,
  applyLeafConfig,
  basisOf,
  boardSends,
  chartLeaf,
  countedOf,
  envSensors,
  homesOf,
  leafChanges,
  leafIssues,
  leafValue,
  limitsOf,
  openLeaf,
  phrase,
  pickSrc,
  placesOf,
  previewText,
  seedRows,
  typeInto,
  zoneVpdAt,
} from "./calibration";
import { LIGHT_LINE, RANGES, type Point, combinedLine, endingNow, entitiesFor, extremes, keptNote, lineColor, periodRuns, sensorLine, tickWords, whenWords, yRange } from "./chart";

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
  /* Said while applying: a write to a board waits for the board to report it. */
  busyText?: string;
  /* What's left after a partial failure, worked out again, so only that is tried again. */
  refresh?: () => Change[];
}

/* Steps this release can open. The others say when they arrive rather than offering a button that does nothing. */
const BUILT: ReadonlySet<SetupStep> = new Set(["details", "devices", "layout", "place", "calibrate"]);

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

/* A chart's readings as last fetched. They're fetched again after a while; the last point is live either way. */
interface HistEntry {
  h: History | null;
  at: number;
  error: string;
  loading: boolean;
}
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const METRIC_KEYS: Metric[] = ["temperature", "humidity", "vpd", "light"];

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
    lay: { state: true },
    leafw: { state: true },
    typing: { state: true },
    metric: { state: true },
    range: { state: true },
    hist: { state: true },
    chartAt: { state: true },
    chartW: { state: true },
    states: { state: true },
    now: { state: true },
    level: { state: true },
    picked: { state: true },
    linkFilter: { state: true },
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
  declare private lay: LayoutDraft | null;
  declare private leafw: LeafDraft | null;
  declare private typing: boolean;
  declare private metric: Metric;
  declare private range: number;
  declare private hist: Record<string, HistEntry>;
  declare private chartAt: number | null;
  declare private chartW: number;
  private chartGeom: { W: number; L: number; PW: number; n: number } | null = null;
  private chartEl: Element | null = null;
  private chartRO: ResizeObserver | null = null;
  private leafBack: { screen: Screen; zoneId: string | null } = { screen: "setup", zoneId: null };
  declare private states: Record<string, HaState>;
  declare private now: number;
  declare private level: "all" | Level;
  declare private picked: string | null;
  declare private linkFilter: string;
  private clock: ReturnType<typeof setInterval> | undefined;
  private layFromGuide = false;
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
    this.lay = null;
    this.leafw = null;
    this.typing = false;
    this.metric = "temperature";
    this.range = 24;
    this.hist = {};
    this.chartAt = null;
    this.chartW = 0;
    this.states = {};
    this.now = Date.now();
    this.level = "all";
    this.picked = null;
    this.linkFilter = "all";
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
    this.addEventListener("focusin", this.onFocus);
    this.addEventListener("focusout", this.onFocus);
    /* Staleness and "reported ago" move with time even when nothing new arrives. */
    this.clock = setInterval(() => (this.now = Date.now()), 15_000);
    parent.postMessage({ v: 1, type: "ready" }, "*");
  }

  disconnectedCallback(): void {
    window.removeEventListener("message", this.onMessage);
    document.removeEventListener("keydown", this.onKey);
    document.removeEventListener("click", this.onOutsideClick);
    this.removeEventListener("focusin", this.onFocus);
    this.removeEventListener("focusout", this.onFocus);
    clearInterval(this.clock);
    this.chartRO?.disconnect();
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
    if (m.type === "init" || m.type === "states") {
      const next: Record<string, HaState> = m.type === "init" ? {} : { ...this.states };
      for (const [e, raw] of Object.entries(m.states)) {
        const st = readState(raw);
        if (st) next[e] = st;
        else delete next[e];
      }
      [this.states, this.now] = [next, Date.now()];
    }
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
    if (this.lay && !this.zoneById(this.lay.zoneId)) this.lay = null;
    if (this.leafw && !this.zoneById(this.leafw.zoneId)) this.leafw = null;
  };

  private askCatalog = async (): Promise<void> => {
    this.catalogError = null;
    const r = await this.ask("catalog");
    if (r.ok && r.catalog) [this.catalog, this.catalogError] = [r.catalog, null];
    else this.catalogError = r.error ?? "Home Assistant couldn't list its devices.";
    /* Sensor Calibration waits for this list, since it says which boards have somewhere to hold an offset. */
    const d = this.leafw;
    if (d && !d.seeded && this.catalog) this.leafw = { ...d, rows: seedRows(this.raw(d.zoneId), this.catalog, this.states), seeded: true };
  };

  /* On a touch screen the box being typed in sits just above the keyboard, which is where the draft bar would land. */
  private onFocus = (e: FocusEvent): void => {
    const el = e.composedPath()[0];
    const field = el instanceof HTMLInputElement && el.type === "text";
    this.typing = e.type === "focusin" && field && matchMedia("(pointer: coarse)").matches;
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
    if (this.lay) return layoutChanges(this.lay, this.config).length;
    if (this.leafw) return this.leafChangeList(this.leafw).length;
    return 0;
  }

  /* The frame can't raise the browser's leave prompt or stop HA's sidebar, so it tells the host whether leaving now would
     lose anything, and only when that changes. */
  protected updated(changed: PropertyValues): void {
    this.fetchWanted();
    const chart = this.shadowRoot?.querySelector(".chart") ?? null;
    if (chart !== this.chartEl) {
      this.chartRO?.disconnect();
      this.chartEl = chart;
      if (chart) {
        this.chartRO = new ResizeObserver(([e]) => {
          const w = Math.round(e.contentRect.width);
          if (w && w !== this.chartW) this.chartW = w;
        });
        this.chartRO.observe(chart);
      }
    }
    const held = this.draftCount > 0;
    this.classList.toggle("drafting", held && !!this.leafw && this.screen === "setup");
    this.classList.toggle("typing", this.typing);
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
    const zone = (this.wiz && (this.zoneById(this.wiz.id)?.name ?? this.wiz.name.trim())) || (this.mapw && this.zoneById(this.mapw.zoneId)?.name) || (this.lay && this.zoneById(this.lay.zoneId)?.name) || (this.leafw && this.zoneById(this.leafw.zoneId)?.name) || "this zone";
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
    this.chartAt = null;
    window.scrollTo(0, 0);
  }

  private leaveTo(screen: Screen, zoneId: string | null = null): void {
    this.guarded(() => {
      this.wiz = null;
      this.mapw = null;
      this.lay = null;
      this.leafw = null;
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
    /* A point read on a touch screen stays until a tap elsewhere. */
    if (this.chartAt !== null && !e.composedPath().some((n) => n instanceof Element && n.classList.contains("chart"))) this.chartAt = null;
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
      this.lay = null;
      this.leafw = null;
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
      const changes = r.refresh ? r.refresh() : r.changes;
      this.modal = changes.length ? { ...r, changes, busy: false, error: result.error ?? "Not saved." } : null;
      if (!changes.length) this.toast(result.error ?? "Not saved.");
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
      this.lay = null;
      this.leafw = null;
      this.guide = id;
      this.go("setup");
    });
  }

  /* Map devices: a draft of which sensors and devices a zone has, against the backend's catalog of what HA has. */
  private openMapDevices(id: string, fromGuide = false): void {
    this.guarded(() => {
      this.wiz = null;
      this.lay = null;
      this.leafw = null;
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

  /* Zone layout and Placement: one wizard opened at different steps, as the mock has it. Zone layout is size then units,
     and carries on to the map when the new grid strands something; Placement is the map. */
  private openLayoutWizard(id: string, flow: (1 | 2 | 3)[], fromGuide = false): void {
    this.guarded(() => {
      this.wiz = null;
      this.mapw = null;
      this.leafw = null;
      this.menu = null;
      this.lay = openLayout(this.config, id, flow);
      this.layFromGuide = fromGuide;
      this.go("setup");
    });
  }

  private setLay(change: (d: LayoutDraft) => void): void {
    if (!this.lay) return;
    const d = structuredClone(this.lay);
    change(d);
    this.lay = d;
  }

  private layItems(d: LayoutDraft): Item[] {
    return [...d.sensors, ...d.devs, ...d.virt];
  }

  /* The list can be long, so a pick brings the map into view for the tap that places it. */
  private pickItem(id: string): void {
    this.setLay((d) => (d.pick = id));
    void this.updateComplete.then(() => this.shadowRoot?.querySelector(".map")?.scrollIntoView({ block: "nearest" }));
  }

  private placeAt(p: Spot): void {
    this.setLay((d) => {
      const s = itemOf(d, d.pick);
      if (s) s.pos = [p[0], p[1]];
    });
  }

  private layBack = (): void => {
    const d = this.lay;
    if (!d) return;
    const flow = flowOf(d), at = flow.indexOf(d.step);
    if (at > 0) {
      this.setLay((x) => (x.step = flow[at - 1]));
      window.scrollTo(0, 0);
      return;
    }
    this.guarded(() => {
      this.lay = null;
    });
  };

  private layDone(zoneId: string): void {
    this.lay = null;
    if (this.layFromGuide) this.guide = zoneId;
    else this.go("zone", zoneId);
  }

  private layNext = (): void => {
    const d = this.lay;
    if (!d) return;
    const flow = flowOf(d), at = flow.indexOf(d.step);
    if (at < flow.length - 1) {
      this.setLay((x) => {
        x.step = flow[at + 1];
        if (x.step === 3) x.pick = firstToPlace(x);
      });
      window.scrollTo(0, 0);
      return;
    }
    if (layoutIssues(d).length || (d.step === 3 && stranded(d).length)) return;
    const step: SetupStep = d.flow[0] === 3 ? "place" : "layout";
    const changes = layoutChanges(d, this.config);
    if (!changes.length) {
      void this.mark(d.zoneId, step, "done");
      this.layDone(d.zoneId);
      return;
    }
    const left = devsOff(d);
    this.modal = {
      kind: "review",
      changes,
      note: `${left.length ? `Not on the map: ${left.map((x) => x.name).join(", ")}. Placing a device is optional. ` : ""}This only changes Environment Control. Nothing in Home Assistant changes.`,
      busy: false,
      error: "",
      apply: () =>
        this.save((c) => {
          applyLayout(c, d);
          markStep(c, d.zoneId, step, "done");
        }),
      after: () => {
        this.toast(step === "place" ? "Placement saved." : "Zone layout saved.");
        this.layDone(d.zoneId);
      },
    };
  };

  /* Sensor Calibration: a page edited freely, so a draft bar rather than a last button. Opened from the guide, the zone
     menu, the VPD tile or a sensor on the map, and Back returns wherever it was opened from. */
  private openCalibration(id: string, fromGuide = false): void {
    this.guarded(() => {
      const back = { screen: this.screen, zoneId: this.zoneId };
      this.wiz = null;
      this.mapw = null;
      this.lay = null;
      this.menu = null;
      this.guide = null;
      this.leafw = openLeaf(this.raw(id), id, this.catalog, this.states, fromGuide);
      this.leafBack = back;
      if (!this.catalog) void this.askCatalog();
      this.go("setup");
    });
  }

  private leafCtx(zoneId: string) {
    const raw = this.raw(zoneId), sensors = envSensors(raw);
    const homesBy: Record<string, Home[]> = Object.fromEntries(sensors.map((s) => [s.id, homesOf(s, this.catalog, this.states)]));
    return { raw, sensors, homesBy, storedBasis: typeof raw?.leafBasis === "string" ? raw.leafBasis : "" };
  }

  private leafChangeList(d: LeafDraft) {
    if (!d.seeded) return [];
    const { sensors, homesBy, storedBasis } = this.leafCtx(d.zoneId);
    return leafChanges(d, sensors, homesBy, storedBasis);
  }

  private setLeaf(change: (d: LeafDraft) => void): void {
    if (!this.leafw) return;
    const d = structuredClone(this.leafw);
    change(d);
    this.leafw = d;
  }

  private leafDone(d: LeafDraft): void {
    this.leafw = null;
    if (d.fromGuide) this.guide = d.zoneId;
    else this.go(this.leafBack.screen, this.leafBack.zoneId);
  }

  private leafExit = (): void => {
    const d = this.leafw;
    if (!d || d.sending) return;
    this.guarded(() => this.leafDone(d));
  };

  private leafDiscard = (): void => {
    const d = this.leafw;
    if (!d || d.sending) return;
    this.leafw = openLeaf(this.raw(d.zoneId), d.zoneId, this.catalog, this.states, d.fromGuide);
  };

  /* Confirming as it stands is how the step counts as done when nothing needed changing. */
  private leafConfirm = async (): Promise<void> => {
    const d = this.leafw;
    if (!d) return;
    await this.mark(d.zoneId, "calibrate", "done");
    this.toast("Sensor Calibration confirmed.");
    if (d.fromGuide) this.leafDone(d);
  };

  /* A box being typed in keeps what's typed until it's left, so a tap on Review commits it first. */
  private commitTyped(): void {
    const el = this.shadowRoot?.activeElement;
    if (el instanceof HTMLInputElement && el.dataset.lin) el.blur();
  }

  private async jumpToTarget(target: string): Promise<void> {
    await this.updateComplete;
    const el = this.shadowRoot?.querySelector(`#${target}`) as HTMLElement | null;
    el?.scrollIntoView({ block: "center" });
    (el?.matches("input, button") ? el : (el?.querySelector("input, button") as HTMLElement | null))?.focus({ preventScroll: true });
  }

  private leafReview = (): void => {
    this.commitTyped();
    const d = this.leafw;
    if (!d || d.sending) return;
    const { sensors, homesBy } = this.leafCtx(d.zoneId);
    const issues = leafIssues(d, sensors, homesBy);
    if (issues.length) return void this.jumpToTarget(issues[0].target);
    const changes = this.leafChangeList(d);
    if (!changes.length) return;
    const boards = changes.some((c) => c.kind === "board"), here = changes.some((c) => c.kind !== "board");
    this.modal = {
      kind: "review",
      changes,
      note: [
        boards ? "Offsets on a board are written to the board, and count once it reports them. Its VPD, and anything reading it such as your alerts, follow straight away." : "",
        here ? "The rest is saved in Environment Control. Nothing else in Home Assistant changes." : "",
      ].filter(Boolean).join(" "),
      busy: false,
      error: "",
      busyText: boards ? "Applying and verifying..." : "Saving...",
      apply: () => this.applyLeaf(d),
      refresh: () => (this.leafw ? this.leafChangeList(this.leafw) : []),
      after: () => {
        const now = this.leafw;
        if (now) this.leafw = openLeaf(this.raw(now.zoneId), now.zoneId, this.catalog, this.states, now.fromGuide);
        this.toast(boards ? "Leaf temperature offsets saved on the boards." : "Leaf temperature offsets saved.");
      },
    };
  };

  /* Environment Control's own record first, then each board that holds something different, each counting only once the
     board reports the new value. Nothing assumes a write landed. */
  private async applyLeaf(d: LeafDraft): Promise<Result> {
    const { sensors, homesBy, storedBasis } = this.leafCtx(d.zoneId);
    const changes = leafChanges(d, sensors, homesBy, storedBasis), sends = boardSends(d, sensors, homesBy);
    if (changes.some((c) => c.kind !== "board")) {
      const r = await this.save((c) => {
        applyLeafConfig(c, d, sensors, homesBy);
        if (!sends.length) markStep(c, d.zoneId, "calibrate", "done");
      });
      if (!r.ok) return r;
    }
    if (!sends.length) return { type: "result", req: 0, ok: true };
    this.setLeaf((x) => {
      x.sending = true;
      for (const s of sends) if (x.rows[s.sensor.id]) x.rows[s.sensor.id].status = "sending";
    });
    const outcomes = await Promise.all(
      sends.map(async (s) => {
        const r = await this.ask("calibrate", { sensor: s.sensor.id, value: s.value });
        return { s, landed: r.ok && (await this.untilReported(s.entity, s.value)), error: r.ok ? "" : (r.error ?? "") };
      }),
    );
    this.setLeaf((x) => {
      x.sending = false;
      for (const o of outcomes) if (x.rows[o.s.sensor.id]) x.rows[o.s.sensor.id].status = o.landed ? "" : "stuck";
    });
    const stuck = outcomes.filter((o) => !o.landed);
    if (stuck.length)
      return {
        type: "result",
        req: 0,
        ok: false,
        error: stuck.map((o) => `${o.s.sensor.name}: ${o.error ? `not sent. ${o.error}` : `not confirmed. The board still reports ${this.reported(o.s.entity)}.`}`).join("\n"),
      };
    await this.mark(d.zoneId, "calibrate", "done");
    return { type: "result", req: 0, ok: true };
  }

  private reported(entity: string): string {
    const v = numberOf(this.states[entity]);
    if (v === null) return "nothing";
    return Math.abs(v) < 1e-9 ? "the same as air" : phrase(v);
  }

  /* Waits for HA to report the board holding the value, and gives up after a while rather than calling it saved. */
  private untilReported(entity: string, value: number): Promise<boolean> {
    const hit = () => {
      const v = numberOf(this.states[entity]);
      return v !== null && Math.abs(v - value) < 1e-6;
    };
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = setInterval(() => {
        if (hit() || Date.now() - start > LEAF_GIVE_UP_MS) {
          clearInterval(tick);
          resolve(hit());
        }
      }, 100);
    });
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

  /* History. Each chart asks the host for exactly the readings it draws, over its range, bucketed by the backend. */
  private envOf(id: string) {
    return sensorsOf(this.raw(id)).filter((s) => s.kind === "env");
  }

  private histWant(id: string, k: Metric, hours: number, buckets: number) {
    const entities = [...new Set(this.envOf(id).flatMap((s) => entitiesFor(s, k)))];
    return entities.length ? { key: `${hours}|${buckets}|${entities.join(",")}`, entities, hours, buckets } : null;
  }

  private chartWant(id: string) {
    const r = RANGES.find((x) => x.hours === this.range) ?? RANGES[1];
    return this.histWant(id, this.metric, r.hours, r.buckets);
  }

  private lightWant(id: string) {
    return this.histWant(id, "light", LIGHT_LINE.hours, LIGHT_LINE.buckets);
  }

  /* What the screen draws: a zone's chart and light line, or every zone's light line on Overview. */
  private fetchWanted(): void {
    if (!this.stored) return;
    const ids = this.screen === "zone" && this.zoneId ? [this.zoneId] : this.screen === "overview" ? this.zones.map((z) => z.id) : [];
    const wants = ids.flatMap((id) => [this.lightWant(id), this.screen === "zone" ? this.chartWant(id) : null]);
    for (const w of wants) {
      if (!w) continue;
      const e = this.hist[w.key];
      if (e && (e.loading || this.now - e.at < HISTORY_REFRESH_MS)) continue;
      this.hist = { ...this.hist, [w.key]: { h: e?.h ?? null, at: this.now, error: "", loading: true } };
      void this.ask("history", { entities: w.entities, hours: w.hours, buckets: w.buckets }).then((r) => {
        const h = r.ok && r.history ? r.history : null;
        this.hist = { ...this.hist, [w.key]: { h: h ?? e?.h ?? null, at: Date.now(), error: h ? "" : (r.error ?? "Home Assistant sent something this panel can't read."), loading: false } };
      });
    }
  }

  /* Every sensor's line ending on its live reading, and with two or more the combined line, by the zone's method. */
  private chartRows(z: Zone, k: Metric, h: History) {
    const sensors = this.envOf(z.id), mode = this.theme?.mode ?? "light", n = Math.round((h.end - h.start) / h.step);
    const blank = Array.from({ length: n }, (_, i): Point => ({ t: h.start + (i + 0.5) * h.step, v: null, lo: null, hi: null }));
    const lines = sensors.map((s) => endingNow(sensorLine(s, k, h, this.states) ?? blank, readSensor(s, this.states, this.now).values[k]));
    const method = this.methodOf(z.id);
    const rows = sensors.map((s, i) => ({ name: s.name, line: lines[i], color: lineColor(mode, i), width: 1 }));
    if (sensors.length < 2) return rows;
    return [{ name: METHODS[method], line: combinedLine(lines, sensors.map((s) => s.avg), method), color: "var(--fg)", width: 1.5 }, ...rows];
  }

  private chartKey = (e: KeyboardEvent): void => {
    const g = this.chartGeom;
    if (!g) return;
    const at = this.chartAt ?? g.n;
    const next: Record<string, number | null> = { ArrowLeft: Math.max(0, at - 1), ArrowRight: at + 1 >= g.n ? null : at + 1, Home: 0, End: null, Escape: null };
    if (!(e.key in next)) return;
    e.preventDefault();
    this.chartAt = next[e.key];
  };

  private chartPointer = (e: PointerEvent): void => {
    const g = this.chartGeom, el = e.currentTarget as Element | null;
    if (!g || !el) return;
    const box = el.getBoundingClientRect(), x = (e.clientX - box.left) * (g.W / box.width);
    this.chartAt = Math.round(Math.min(1, Math.max(0, (x - g.L) / g.PW)) * g.n);
  };

  private historyCard(z: Zone) {
    const k = this.metric, R = RANGES.find((x) => x.hours === this.range) ?? RANGES[1];
    const seg = (label: string, items: [string, string][], cur: string, pick: (v: string) => void) =>
      html`<div class="seg" role="group" aria-label=${label}>${items.map(([v, l]) => html`<button aria-pressed=${cur === v ? "true" : "false"} @click=${() => pick(v)}>${l}</button>`)}</div>`;
    const head = html`<div class="card-head">
      <h2>History</h2>
      <div class="row">
        ${seg("Metric", METRIC_KEYS.map((m) => [m, METRIC[m].short]), k, (v) => ([this.metric, this.chartAt] = [v as Metric, null]))}
        ${seg("Range", RANGES.map((r) => [String(r.hours), r.label]), String(R.hours), (v) => ([this.range, this.chartAt] = [Number(v), null]))}
      </div>
    </div>`;
    const want = this.chartWant(z.id), e = want ? this.hist[want.key] : undefined;
    if (!this.envOf(z.id).length) return html`<section class="card">${head}<p class="small muted">No environment sensors in ${z.name} yet.</p></section>`;
    if (!want) return html`<section class="card">${head}<p class="small muted">No sensor in ${z.name} reads ${METRIC[k].label.toLowerCase()}.</p></section>`;
    if (!e?.h)
      return html`<section class="card">${head}<p class="small muted">${e?.error ? `Couldn't read the history. ${e.error}` : "Reading the history from Home Assistant."}</p></section>`;
    const h = e.h, rows = this.chartRows(z, k, h), n = rows[0].line.length - 1;
    const raw = this.raw(z.id), judged = this.judged(z), dayAt = Number(raw?.dayAt ?? 0), nightAt = Number(raw?.nightAt ?? 0);
    const bands = judged && k !== "light" ? { day: bandsOf(raw, "day", k), night: bandsOf(raw, "night", k) } : null;
    const limits = bands ? [bands.day, bands.night].flatMap((b) => (b ? [b[0], b[4]].filter((x): x is number => x !== null) : [])) : [];
    const [lo, hi] = yRange(rows.map((r) => r.line), k, limits);
    const W = Math.max(300, this.chartW || 300), H = W < 520 ? 210 : 260, L = 46, Rm = 8, T = 8, B = 22, PW = W - L - Rm, PH = H - T - B;
    this.chartGeom = { W, L, PW, n };
    const X = (i: number) => L + (n ? i / n : 0) * PW, Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * PH;
    const runs = judged ? periodRuns(rows[0].line, dayAt, nightAt) : [];
    const parts: TemplateResult[] = [];
    for (const r of runs) {
      const x = X(r.from), w = X(Math.min(n, r.to + 1)) - x;
      if (!r.day) parts.push(svg`<rect x=${x} y=${T} width=${w} height=${PH} fill="var(--shade)"></rect>`);
      const b = bands?.[r.day ? "day" : "night"];
      if (b) {
        const [mn, l2, tg, h2, mx] = b.map((v) => v ?? 0);
        parts.push(svg`<rect x=${x} y=${Y(mx)} width=${w} height=${Math.max(0, Y(mn) - Y(mx))} fill="var(--band)"></rect><rect x=${x} y=${Y(h2)} width=${w} height=${Math.max(0, Y(l2) - Y(h2))} fill="var(--ideal)"></rect>`);
        if (b[2] !== null) parts.push(svg`<line x1=${x} x2=${x + w} y1=${Y(tg)} y2=${Y(tg)} stroke="var(--muted)" stroke-dasharray="3 3"></line>`);
      }
    }
    const span = hi - lo, dp = k === "vpd" ? 2 : k !== "light" && span < 5 ? 1 : 0;
    const axis = (v: number) => (k === "light" ? (hi < 8000 ? Math.round(v).toLocaleString() : `${Math.round(v / 1000)}k`) : v.toFixed(dp));
    for (let t = 0; t <= 4; t++) {
      const v = lo + (span * t) / 4, y = Y(v);
      parts.push(svg`<line x1=${L} x2=${W - Rm} y1=${y} y2=${y} stroke="var(--line)"></line><text x=${L - 6} y=${y + 4} text-anchor="end">${axis(v)}</text>`);
    }
    const ticks = W < 520 ? 3 : 6;
    for (let t = 0; t <= ticks; t++) {
      const ix = Math.round((t / ticks) * n);
      parts.push(svg`<text x=${X(ix)} y=${H - 6} text-anchor=${t === 0 ? "start" : t === ticks ? "end" : "middle"}>${tickWords(rows[0].line[ix].t, R.hours)}</text>`);
    }
    const path = (line: Point[]) => {
      let d = "", pen = false;
      line.forEach((p, i) => {
        if (p.v === null) return void (pen = false);
        d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const many = rows.length > 1;
    for (const r of [...rows].reverse())
      parts.push(svg`<path d=${path(r.line)} fill="none" stroke=${r.color} stroke-width=${r.width} stroke-opacity=${many && r.width === 1 ? 0.55 : 1}></path>`);
    const at = this.chartAt, shown = at ?? n;
    if (at !== null) {
      parts.push(svg`<line x1=${X(at)} x2=${X(at)} y1=${T} y2=${T + PH} stroke="var(--muted)"></line>`);
      for (const r of rows) if (r.line[at].v !== null) parts.push(svg`<circle cx=${X(at)} cy=${Y(r.line[at].v as number)} r="3" fill=${r.color}></circle>`);
    }
    const showExtremes = k !== "light";
    const cell = (m: { v: number; t: number } | null) => (m ? html`${fmt(k, m.v)}<span class="sub">${whenWords(m.t, R.hours)}</span>` : "--");
    const note = keptNote(h, R.hours);
    return html`<section class="card">
      ${head}
      <div class="chart">
        <svg
          viewBox="0 0 ${W} ${H}"
          tabindex="0"
          role="img"
          aria-label="${METRIC[k].label} over the last ${R.label} for ${z.name}. Move across it, or use the left and right arrows, to read a point in time."
          @pointerdown=${this.chartPointer}
          @pointermove=${this.chartPointer}
          @pointerleave=${(ev: PointerEvent) => ev.pointerType === "mouse" && (this.chartAt = null)}
          @keydown=${this.chartKey}
        >
          ${parts}
        </svg>
      </div>
      <div class="tbl-wrap">
        <table class="cstats">
          <thead>
            <tr>
              <th>${METRIC[k].unit}</th>
              <th>${at === null ? "Now" : whenWords(rows[0].line[at].t, R.hours)}</th>
              ${showExtremes ? html`<th>Min</th><th>Max</th>` : nothing}
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => {
              const ex = extremes(r.line);
              return html`<tr>
                <td><i style="background:${r.color}"></i>${r.name}</td>
                <td>${fmt(k, r.line[shown].v)}</td>
                ${showExtremes ? html`<td>${cell(ex.min)}</td><td>${cell(ex.max)}</td>` : nothing}
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
      ${note ? html`<p class="chart-note">${note}</p>` : nothing}
      <div class="key">
        ${bands ? html`<span><i style="background:var(--ideal)"></i>Ideal zone</span><span><i style="background:var(--band);outline:1px solid var(--line)"></i>Min to max</span>` : nothing}
        ${runs.some((r) => !r.day) ? html`<span><i style="background:var(--shade);outline:1px solid var(--line)"></i>Lights off</span>` : nothing}
      </div>
    </section>`;
  }

  /* The zone's combined light over the last 4 hours, as the HA dashboard draws it: black to yellow between 1210 and
     2120 lx. The zone's light card and its Overview card draw the same line. */
  private lightSpark(z: Zone, height: number, cls: string) {
    const want = this.lightWant(z.id), h = want ? this.hist[want.key]?.h : null;
    if (!h) return nothing;
    const rows = this.chartRows(z, "light", h), pts = rows[0].line, n = pts.length - 1;
    const vals = pts.flatMap((p) => (p.v === null ? [] : [p.v]));
    if (!vals.length) return nothing;
    const W = 300, max = Math.max(...vals, 2120) * 1.05, X = (i: number) => (n ? i / n : 0) * W, Y = (v: number) => height - 3 - (v / max) * (height - 6);
    let d = "", pen = false;
    pts.forEach((p, i) => {
      if (p.v === null) return void (pen = false);
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`;
      pen = true;
    });
    const id = `lg-${cls}-${z.id}`, name = rows.length > 1 ? `Light (${rows[0].name})` : "Light";
    return html`<svg class=${cls} viewBox="0 0 ${W} ${height}" preserveAspectRatio="none" role="img" aria-label="${name} in ${z.name} over the last 4 hours">
      ${svg`<defs><linearGradient id=${id} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1=${Y(2120)} y2=${Y(1210)}><stop offset="0" style="stop-color:var(--lhigh)"></stop><stop offset="1" style="stop-color:var(--llow)"></stop></linearGradient></defs>
      <path d=${d} fill="none" stroke="url(#${id})" stroke-width="2" vector-effect="non-scaling-stroke"></path>`}
    </svg>`;
  }

  /* Live readings. */
  private raw(id: string | null): Record<string, unknown> | undefined {
    return this.config.zones.find((z) => z.id === id);
  }

  private methodOf(id: string): Method {
    const c = this.raw(id)?.combine as Record<string, unknown> | undefined;
    return c && typeof c.env === "string" && c.env in METHODS ? (c.env as Method) : "mean";
  }

  private readingsOf(id: string): SensorReading[] {
    return sensorsOf(this.raw(id)).filter((s) => s.kind === "env").map((s) => readSensor(s, this.states, this.now));
  }

  private zoneNow(id: string, k: Metric): ZoneReading {
    return zoneReading(this.readingsOf(id), k, this.methodOf(id));
  }

  /* A zone made before setup steps were recorded counts as having its targets; a new one waits for Targets. */
  private judged(z: Zone): boolean {
    return !this.raw(z.id)?.setup || z.setup.targets === "done";
  }

  private minuteNow(): number {
    const d = new Date(this.now);
    return d.getHours() * 60 + d.getMinutes();
  }

  private periodNow(z: Zone): "day" | "night" {
    const r = this.raw(z.id), dayAt = Number(r?.dayAt ?? 0), nightAt = Number(r?.nightAt ?? 0);
    return isDay(dayAt, nightAt, this.minuteNow()) ? "day" : "night";
  }

  private stateOf(z: Zone, k: Metric): BandState {
    if (k === "light") return "unset";
    return bandState(bandsOf(this.raw(z.id), this.periodNow(z), k), this.zoneNow(z.id, k).value, this.judged(z));
  }

  private pill(state: BandState) {
    return html`<span class="pill ${state === "unset" ? "plain" : state}">${BAND_WORDS[state]}</span>`;
  }

  private ic(name: "thermo" | "drop" | "gauge" | "sun", color: string) {
    return html`<span class="ic" style="--c:${color}">${icon(name)}</span>`;
  }

  private track(z: Zone, k: Metric) {
    const band = bandsOf(this.raw(z.id), this.periodNow(z), k), v = this.zoneNow(z.id, k).value;
    if (!this.judged(z) || !band) return html`<div class="track unset" aria-hidden="true"><span class="bandc"></span></div>`;
    const [mn, lo, tg, hi, mx] = band.map((x) => x ?? 0), pad = (mx - mn) * 0.35, a = mn - pad, b = mx + pad || 1;
    const x = (n: number) => Math.min(100, Math.max(0, ((n - a) / (b - a)) * 100));
    return html`<div class="track" aria-hidden="true">
      <span class="bandc"></span><span class="bandr" style="left:${x(mn)}%;width:${x(mx) - x(mn)}%"></span><span class="bandi" style="left:${x(lo)}%;width:${x(hi) - x(lo)}%"></span>
      ${band[2] === null ? nothing : html`<span class="tick" style="left:${x(tg)}%"></span>`}${v === null ? nothing : html`<span class="dot ${this.stateOf(z, k)}" style="left:${x(v)}%"></span>`}
    </div>`;
  }

  private periodBlock(z: Zone) {
    const r = this.raw(z.id), light = this.zoneNow(z.id, "light").value;
    if (!this.judged(z)) return html`<div class="period"><div class="period-top"><span><strong>Day and night not set up</strong></span><span class="muted">Set with Targets, day and night</span></div></div>`;
    const dayAt = Number(r?.dayAt ?? 0), nightAt = Number(r?.nightAt ?? 0), day = this.periodNow(z) === "day", now = this.minuteNow();
    const seg = (a: number, b: number) => html`<i style="left:${a / 14.4}%;width:${(b - a) / 14.4}%"></i>`;
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const left = ((((day ? nightAt : dayAt) - now) % 1440) + 1440) % 1440;
    return html`<div class="period">
      <div class="period-top">
        <span><strong>${day ? "Lights on" : "Lights off"}</strong>${light === null ? nothing : html`<span class="lux">${fmt("light", light)} lx</span>`}</span>
        <span class="muted">${hhmm(dayAt)} - ${hhmm(nightAt)}, ${Math.floor(left / 60)}h ${String(left % 60).padStart(2, "0")}m left</span>
      </div>
      <div class="strip" role="img" aria-label="Lights on ${hhmm(dayAt)} to ${hhmm(nightAt)}, time now ${hhmm(now)}">
        ${dayAt < nightAt ? seg(dayAt, nightAt) : html`${seg(dayAt, 1440)}${seg(0, nightAt)}`}<b style="left:${now / 14.4}%"></b>
      </div>
    </div>`;
  }

  private static readonly LOOKS: Record<Metric, ["thermo" | "drop" | "gauge" | "sun", string]> = {
    temperature: ["thermo", "var(--temp)"],
    humidity: ["drop", "var(--hum)"],
    vpd: ["gauge", "var(--vpd)"],
    light: ["sun", "var(--sun)"],
  };

  /* Which sensors made a reading, and which were left out and why, so a combined number never hides a dead sensor. */
  private combinedWords(id: string, k: Metric): string {
    const r = this.zoneNow(id, k), all = this.readingsOf(id);
    if (all.length < 2) return r.missing.length ? `${r.missing[0].name} has no data.` : "";
    const parts = r.used.map((s) => `${s.name} ${fmt(k, s.values[k])}`);
    const out = [`${METHODS[r.method]} of ${r.used.length}${parts.length ? `: ${parts.join(", ")}` : ""}`];
    for (const s of r.missing) out.push(`${s.name} ${s.health === "stale" ? "is stale" : "has no data"}, left out`);
    if (r.notCounted.length) out.push(`${r.notCounted.map((s) => s.name).join(", ")} not counted`);
    return `${out.join(". ")}.`;
  }

  private overview() {
    if (!this.stored) return html`<p class="muted">Waiting for Home Assistant.</p>`;
    if (!this.zones.length)
      return html`<section class="card">
        <h2>No zones yet</h2>
        <p class="muted">Add a zone, then map its sensors and devices from Home Assistant.</p>
        <div class="row">${this.addButton("Add a zone")}</div>
      </section>`;
    const METRICS: Metric[] = ["temperature", "humidity", "vpd"];
    const issues = this.zones
      .filter((z) => this.judged(z) && this.readingsOf(z.id).length)
      .flatMap((z) => METRICS.map((k) => ({ z, k, state: this.stateOf(z, k) })))
      .filter((x) => !["ok", "unset"].includes(x.state));
    const group = (list: typeof issues, title: string, cls: string) =>
      list.length
        ? html`<div class="notice ${cls}">
            <strong>${title}</strong>${list.map((x) => html`<button class="fixlink" @click=${() => this.go("zone", x.z.id)}>${x.z.name} ${METRIC[x.k].short} ${BAND_WORDS[x.state].toLowerCase()} &rsaquo;</button>`)}
          </div>`
        : nothing;
    const judgedAny = this.zones.some((z) => this.judged(z) && this.readingsOf(z.id).length);
    return html`${issues.length
        ? html`${group(issues.filter((x) => x.state.startsWith("crit")), "Critical", "critical")}${group(issues.filter((x) => !x.state.startsWith("crit")), "Outside ideal zone", "")}`
        : judgedAny
          ? html`<div class="notice calm"><strong>All zones ideal</strong></div>`
          : nothing}
      <div class="cards">
        ${this.zones.map((z) => {
          const n = this.readingsOf(z.id).filter((s) => s.counted && s.health === "ok").length, light = this.zoneNow(z.id, "light").value;
          return html`<button class="card zone-card" @click=${() => this.go("zone", z.id)}>
            <div class="card-head"><h2>${z.name}</h2>${stepsLeft(z).length ? html`<span class="pill warn">Not set up</span>` : nothing}</div>
            ${z.description ? html`<p class="small muted">${z.description}</p>` : nothing} ${this.periodBlock(z)}
            <div class="rows">
              ${METRICS.map(
                (k) => html`<div class="mrow">
                  ${this.ic(...EcApp.LOOKS[k])}
                  <div><div class="t1">${METRIC[k].label}</div><div class="t2">${fmt(k, this.zoneNow(z.id, k).value)}<span>${METRIC[k].unit}</span></div></div>
                  ${this.track(z, k)}
                  <div class="pillcell">${this.pill(this.readingsOf(z.id).length ? this.stateOf(z, k) : "unset")}</div>
                </div>`,
              )}
              <div class="mrow">
                ${this.ic(...EcApp.LOOKS.light)}
                <div><div class="t1">Light</div><div class="t2">${fmt("light", light)}<span>lx</span></div></div>
                ${this.lightSpark(z, 34, "lspark")}
              </div>
            </div>
            ${n >= 2 ? html`<p class="small muted">${METHODS[this.methodOf(z.id)]} of ${n} sensors.</p>` : nothing}
            <p class="small muted">${this.zoneCounts(z)}</p>
          </button>`;
        })}
      </div>`;
  }

  private tile(z: Zone, k: Metric) {
    const r = this.zoneNow(z.id, k), band = bandsOf(this.raw(z.id), this.periodNow(z), k), words = this.combinedWords(z.id, k);
    return html`<div class="tile">
      <div class="tile-top">${this.ic(...EcApp.LOOKS[k])}<div><div class="name">${METRIC[k].label}</div><div class="val">${fmt(k, r.value)} <small>${METRIC[k].unit}</small></div></div></div>
      ${words ? html`<div class="tavg">${words}</div>` : nothing}
      ${k === "vpd" && this.readingsOf(z.id).length
        ? html`<div class="tavg">${this.leafLine(z)} <button class="fixlink small" @click=${() => this.openCalibration(z.id)}>Change &rsaquo;</button></div>`
        : nothing}
      ${this.track(z, k)}
      ${this.judged(z) && band
        ? html`<div class="range">${["Min", "Low", "Target", "High", "Max"].map((l, i) => html`<span><b>${band[i] === null ? "-" : band[i]}</b>${l}</span>`)}</div>
            <div>${this.pill(this.stateOf(z, k))}</div>`
        : html`<button class="fixlink small" @click=${() => this.openGuide(z.id)}>Targets not set up yet &rsaquo;</button>`}
    </div>`;
  }

  /* The offset each VPD uses, said once when every sensor shares one. */
  private leafLine(z: Zone): string {
    const offsets = new Set(sensorsOf(this.raw(z.id)).filter((s) => s.kind === "env").map((s) => leafOf(s, this.states)));
    if (offsets.size !== 1) return "Leaf temperature offset per sensor.";
    const x = [...offsets][0];
    return `Leaf temperature offset ${x > 0 ? "+" : ""}${x.toFixed(1)} °C.`;
  }

  private lightCard(z: Zone) {
    const r = this.zoneNow(z.id, "light"), all = this.readingsOf(z.id);
    return html`<div class="lcard">
      <div class="name">${all.length >= 2 ? `Light (${METHODS[r.method]})` : "Light"}</div>
      <div class="val">${fmt("light", r.value)} <small>lx</small></div>
      ${this.lightSpark(z, 60, "lline")}
    </div>`;
  }

  /* What tapping a mark tells: where it is, its height, its reading and when it last reported. */
  private markDetail(z: Zone) {
    const c = this.config, items = zoneItems(c, z.id), L = storedLayout(this.raw(z.id));
    const it = [...items.sensors, ...items.devs, ...items.virt].find((x) => x.id === this.picked && x.pos);
    if (!it) return html`<div class="detail muted">Tap a sensor or device to see where it is and how it's doing.</div>`;
    const where = posText(it.pos as Spot, L);
    if (it.kind === "virtual") return html`<div class="detail"><strong>${it.name}</strong><span>${where}.</span><span class="muted">Virtual device. Home Assistant doesn't have it, so it's only shown on the map.</span></div>`;
    if (it.kind === "device") {
      const entity = this.storedEntity(it.id), st = entity ? this.states[entity] : undefined;
      const state = !st || st.state === "unavailable" || st.state === "unknown" ? "Unavailable" : st.state === "on" ? "On" : st.state === "off" ? "Off" : st.state;
      return html`<div class="detail"><strong>${it.name}</strong><span>${where}. ${it.type ?? "Not said what it is"}.</span><span>${state}.</span><span class="muted">${entity ?? ""}</span></div>`;
    }
    const s = sensorsOf(this.raw(z.id)).find((x) => x.id === it.id);
    if (!s) return nothing;
    if (s.kind === "soil") {
      const v = (k: string, unit: string) => {
        const e = s.entities[k], n = e ? numberOf(this.states[e]) : null;
        return n === null ? "--" : `${n.toFixed(k === "ec" ? 2 : 1)} ${unit}`;
      };
      return html`<div class="detail"><strong>${it.name}</strong><span>${where}. In the substrate.</span><span>Moisture ${v("moisture", "%")}, pwEC ${v("ec", "mS/cm")}, ${v("temperature", "°C")}.</span><span class="muted">Soil probe readings arrive in full with irrigation.</span></div>`;
    }
    const r = readSensor(s, this.states, this.now);
    const reading = r.health === "dead" ? "No data. Left out of the zone's readings." : r.health === "stale" ? "Stale. Left out of the zone's readings." : `${fmt("temperature", r.values.temperature)} °C, ${fmt("humidity", r.values.humidity)} % RH, VPD ${fmt("vpd", r.values.vpd)} kPa${s.avg ? "" : ". Not counted in the zone's readings"}`;
    const x = leafOf(s, this.states);
    return html`<div class="detail">
      <strong>${it.name}</strong><span>${where}. ${it.level ? LEVELS[it.level] : "Height not set"}.</span><span>${reading}.</span>
      <span class="muted">${ago(r.at, this.now)}</span>
      <span class="muted"
        >${x === 0 ? "Leaf the same as air" : `Leaf ${Math.abs(x).toFixed(1)} °C ${x < 0 ? "below" : "above"} air`}, from ${s.leafEntity && !s.leafUnused ? "the board" : "Environment Control"}.
        <button class="fixlink small" @click=${() => this.openCalibration(z.id)}>Change &rsaquo;</button></span
      >
    </div>`;
  }

  /* The zone's map as it's placed, with a height filter. Devices have no height, so they show only under All. */
  private zoneMap(z: Zone) {
    const c = this.config, L = storedLayout(this.raw(z.id)), items = zoneItems(c, z.id);
    const shown = [
      ...items.sensors.filter((s) => this.level === "all" || (s.kind === "env" && s.level === this.level)),
      ...(this.level === "all" ? [...items.devs.filter((x) => x.pos), ...items.virt] : []),
    ];
    const left = items.devs.filter((x) => !x.pos);
    return html`<section class="card">
      <div class="card-head">
        <h2>Placement</h2>
        ${this.chips("Height", `level-filter-${z.id}`, [{ value: "all", label: "All" }, ...(Object.keys(LEVELS) as Level[]).map((k) => ({ value: k, label: LEVELS[k] }))], this.level, (v) => (this.level = v as "all" | Level))}
      </div>
      ${mapView(L, { items: shown, picked: this.picked, onPick: (id) => (this.picked = this.picked === id ? null : id), label: `Units, sensors and devices in ${z.name}` })}
      ${keyView}
      ${left.length
        ? html`<p class="small muted">
            ${plural(left.length, "device")} ${left.length > 1 ? "aren't" : "isn't"} on the map: ${left.map((x) => x.name).join(", ")}. They don't need to be, but only placed devices show
            here. <button class="fixlink" @click=${() => this.openLayoutWizard(z.id, [3])}>Place devices &rsaquo;</button>
          </p>`
        : nothing}
      ${this.markDetail(z)}
    </section>`;
  }

  private zoneCounts(z: Zone): string {
    const devices = this.devices.filter((d) => d.zones.includes(z.id)).length, placed = z.sensors.filter((s) => s.placed).length;
    return `${plural(devices, "device")}. ${placed} of ${plural(z.sensors.length, "sensor")} placed.`;
  }

  private zone() {
    const z = this.zoneById(this.zoneId);
    if (!z) return nothing;
    const left = stepsLeft(z), L = storedLayout(this.raw(z.id));
    return html`<div>
        <h1>${z.name}</h1>
        ${z.description ? html`<p class="muted">${z.description}</p>` : nothing}
        <p class="muted small">${L.w} x ${L.d} m, ${plural(L.units, "unit")}</p>
      </div>
      ${left.length
        ? html`<button class="notice fix" @click=${() => this.openGuide(z.id)}>
            <span>Not set up yet. Still to confirm: ${left.map((k) => STEP_TITLE[k]).join(", ")}.</span><span class="fixgo">Continue setup &rsaquo;</span>
          </button>`
        : nothing}
      ${this.periodBlock(z)}
      <div class="tiles">${(["temperature", "humidity", "vpd"] as Metric[]).map((k) => this.tile(z, k))}${this.lightCard(z)}</div>
      ${this.zoneMap(z)}${this.historyCard(z)}
      <p class="small muted">Controls and activity arrive in the releases that follow.</p>`;
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

  /* Every mapped device and sensor: what it is and how it reaches Home Assistant, as the mock's Devices has it. */
  private devicesScreen() {
    const c = this.config, zoneName = (id: string) => this.zones.find((z) => z.id === id)?.name ?? id;
    type Row = { name: string; zones: string[]; role: string; family: string; link: LinkKind; source: string; path: string; hub: string; state: string; down: boolean };
    const rows: Row[] = [];
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    for (const d of c.devices) {
      if (!Array.isArray(d.zones) || !d.zones.length) continue;
      const st = typeof d.entity === "string" ? this.states[d.entity] : undefined, down = !st || st.state === "unavailable" || st.state === "unknown";
      const bri = st && typeof st.attributes.brightness === "number" ? `, ${Math.round((st.attributes.brightness / 255) * 100)}%` : "";
      const mode = st && typeof st.attributes.mode === "string" ? `, ${st.attributes.mode} mode` : "";
      rows.push({
        name: str(d.name) || str(d.entity), zones: d.zones as string[], role: str(d.type), family: str(d.family), link: (str(d.link) || "unknown") as LinkKind, source: str(d.linkSource),
        path: str(d.path), hub: str(d.hub), state: down ? "Unavailable" : st.state === "on" ? `On${bri}${mode}` : st.state === "off" ? "Off" : st.state, down,
      });
    }
    const seen = new Set<string>();
    for (const z of c.zones)
      for (const s of sensorsOf(z)) {
        const raw = (Array.isArray(z.sensors) ? z.sensors : []).find((x) => typeof x === "object" && x !== null && (x as { id?: unknown }).id === s.id) as Record<string, unknown>;
        if (seen.has(s.id)) {
          rows.find((r) => r.name === s.name)?.zones.push(z.id as string);
          continue;
        }
        seen.add(s.id);
        const h = s.kind === "env" ? readSensor(s, this.states, this.now).health : healthOf(this.states[s.entities.moisture ?? s.entities.temperature ?? ""], this.now);
        rows.push({
          name: s.name, zones: [z.id as string], role: s.kind === "soil" ? "Soil probe" : "Environment sensor", family: str(raw?.family), link: (str(raw?.link) || "unknown") as LinkKind,
          source: str(raw?.linkSource), path: "", hub: "", state: h === "ok" ? "Online" : h === "stale" ? "Stale" : "No data", down: h !== "ok",
        });
      }
    const filters: [string, string][] = [["all", "All"], ["ethernet", "Ethernet"], ["wifi", "WiFi"], ["zigbee", "Zigbee"], ["cloud", "Cloud"], ["unknown", "Not known"]];
    const shown = rows.filter((r) => this.linkFilter === "all" || (this.linkFilter === "cloud" ? r.path === "cloud" : r.link === this.linkFilter));
    const src: Record<string, string> = { detected: "Detected", confirmed: "You confirmed" };
    return html`<div><h1>Devices</h1><p class="muted small">What each mapped device and sensor is, and how it reaches Home Assistant.</p></div>
      <section class="card">
        ${this.chips("Link", "link-filter", filters.map(([value, label]) => ({ value, label })), this.linkFilter, (v) => (this.linkFilter = v))}
        <div class="tbl-wrap">
          <table style="min-width:640px">
            <thead><tr><th>Device</th><th>Role</th><th>Integration</th><th>Link</th><th>Path</th><th>State</th></tr></thead>
            <tbody>
              ${shown.length
                ? shown.map(
                    (r) => html`<tr>
                      <td>${r.name}<span class="sub">${r.zones.map(zoneName).join(", ")}</span></td>
                      <td>${r.role || html`<span class="pill dead">Not known yet</span>`}</td>
                      <td>${r.family}</td>
                      <td><span class="pill ${r.link === "unknown" ? "dead" : "plain"}">${LINK_LABEL[r.link]}</span><span class="sub">${r.link === "unknown" ? "Setup will ask" : (src[r.source] ?? "")}</span></td>
                      <td>${PATH_LABEL[r.path as PathKind] ?? ""}${r.hub ? html`<span class="sub">via ${r.hub}</span>` : nothing}</td>
                      <td>${r.down ? html`<span class="pill dead">${r.state}</span>` : r.state}</td>
                    </tr>`,
                  )
                : html`<tr><td colspan="6" class="muted">${this.linkFilter === "all" ? "Nothing is in a zone yet. Map devices adds them." : "Nothing on this link."}</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <details>
          <summary>Everything in Home Assistant</summary>
          ${this.catalogList()}
        </details>
      </section>`;
  }

  private catalogList() {
    if (this.catalogError) return html`<p>${this.catalogError}</p><div class="row"><button class="btn" @click=${this.askCatalog}>Try again</button></div>`;
    if (!this.catalog) return html`<p class="muted">Asking Home Assistant.</p>`;
    const byArea = new Map<string, CatalogDevice[]>();
    for (const d of this.catalog.devices) byArea.set(d.area ?? "No area", [...(byArea.get(d.area ?? "No area") ?? []), d]);
    const loose = this.catalog.entities;
    return html`<p class="small muted">
        ${plural(this.catalog.devices.length, "device")} in Home Assistant. How each is connected is read from Home Assistant, and anything it can't tell says not known.
      </p>
      ${[...byArea].map(([area, list]) => html`<h3>${area}</h3><ul>${list.map((d) => this.deviceRow(d))}</ul>`)}
      ${loose.length
        ? html`<h3>Belonging to no device</h3>
            <details>
              <summary>${loose.length === 1 ? "1 entity, such as a helper or template" : `${loose.length} entities, such as helpers and templates`}</summary>
              <ul>${loose.map((e) => this.entityRow(e))}</ul>
            </details>`
        : nothing}`;
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

  /* A step that can't be done yet says why rather than offering a button that does nothing. */
  private stepBlocked(z: Zone, k: SetupStep): string {
    if (k === "calibrate") return envSensors(this.raw(z.id)).length ? "" : "Needs sensors from Map devices";
    if (k !== "place") return "";
    const items = zoneItems(this.config, z.id);
    return items.sensors.length || items.devs.length || items.virt.length ? "" : "Needs sensors from Map devices";
  }

  private openStep(id: string, k: SetupStep): void {
    if (k === "details") this.openDetails(id, true);
    else if (k === "devices") this.openMapDevices(id, true);
    else if (k === "layout") this.openLayoutWizard(id, [1, 2], true);
    else if (k === "place") this.openLayoutWizard(id, [3], true);
    else if (k === "calibrate") this.openCalibration(id, true);
  }

  private guideScreen(id: string) {
    const z = this.zoneById(id);
    if (!z) return nothing;
    const next = SETUP_STEPS.find((k) => BUILT.has(k) && z.setup[k] !== "done" && !this.stepBlocked(z, k));
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
            const state = z.setup[k], built = BUILT.has(k), blocked = built && this.stepBlocked(z, k);
            const pill =
              state === "done"
                ? html`<span class="pill ok">Done</span>`
                : !built
                  ? html`<span class="pill dashed">In a later release</span>`
                  : blocked
                    ? html`<span class="pill dashed">${blocked}</span>`
                    : state === "later"
                      ? html`<span class="pill plain">Later</span>`
                      : nothing;
            return html`<div class="task" id="g-${k}" aria-current=${k === next ? "step" : nothing}>
              <div><strong>${i + 1}. ${STEP_TITLE[k]}</strong><p class="small muted">${STEP_TEXT[k]}</p></div>
              <div class="row">
                ${pill}
                ${built
                  ? html`<button class="btn ${k === next ? "primary" : ""}" ?disabled=${!!blocked} @click=${() => this.openStep(z.id, k)}>${STEP_TITLE[k]}</button>`
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

  private number(id: string, label: string, value: number, attrs: { min: number; max: number; step: number }, set: (v: number) => void) {
    return html`<label class="field" for=${id}
      >${label}<input
        id=${id}
        type="number"
        inputmode="decimal"
        min=${attrs.min}
        max=${attrs.max}
        step=${attrs.step}
        .value=${Number.isFinite(value) ? String(value) : ""}
        @input=${(e: Event) => set(Number.parseFloat((e.target as HTMLInputElement).value))}
    /></label>`;
  }

  private layWizard(d: LayoutDraft) {
    const z = this.zoneById(d.zoneId);
    if (!z) return nothing;
    const flow = flowOf(d), at = flow.indexOf(d.step), last = at === flow.length - 1;
    const NAMES = { 1: "Size", 2: "Units", 3: "Sensors and devices" } as const;
    const steps = flow.length > 1 ? html`<ol class="steps">${flow.map((n, i) => html`<li aria-current=${i === at ? "step" : nothing}>${i + 1}. ${NAMES[n]}</li>`)}</ol>` : nothing;
    const issues = layoutIssues(d), lost = stranded(d), changes = last ? layoutChanges(d, this.config).length : 0;
    let body: unknown = nothing;
    if (d.step === 1)
      body = html`<p class="muted">Measure the inside of the zone.</p>
        <div class="fields">
          ${this.number("lay-w", "Width in metres", d.w, { min: 0.1, max: 100, step: 0.1 }, (v) => this.setLay((x) => typed(x, "w", v)))}
          ${this.number("lay-d", "Depth in metres", d.d, { min: 0.1, max: 100, step: 0.1 }, (v) => this.setLay((x) => typed(x, "d", v)))}
        </div>`;
    if (d.step === 2) {
      const L = { w: d.w, d: d.d, units: d.units, rows: d.rows, cols: d.cols };
      const lostSensors = lost.filter((s) => s.pos && s.kind !== "virtual"), lostVirt = lost.filter((s) => s.pos && s.kind === "virtual");
      const movedOff = d.devs.filter((x) => x.pos && !fits(x, L));
      const notice = (list: Item[], what: string, then: string) =>
        list.length
          ? html`<div class="notice"><strong>${plural(list.length, what)} no longer ${list.length > 1 ? "fit" : "fits"}</strong><span>${list.map((x) => x.name).join(", ")}. ${then}</span></div>`
          : nothing;
      const stepper = (key: "rows" | "cols", label: string) => html`<span class="small muted">${label}</span>
        <span class="stepper"
          ><button aria-label="Fewer ${label.toLowerCase()}" @click=${() => this.setLay((x) => (x[key] = Math.max(1, x[key] - 1)))}>-</button><span>${d[key]}</span
          ><button aria-label="More ${label.toLowerCase()}" @click=${() => this.setLay((x) => (x[key] = Math.min(MAX_GRID, x[key] + 1)))}>+</button></span
        >`;
      body = html`<div class="fields">${this.number("lay-u", "Units", d.units, { min: 1, max: 200, step: 1 }, (v) => this.setLay((x) => typed(x, "units", v)))}</div>
        <div class="row">
          ${stepper("rows", "Rows")}${stepper("cols", "Columns")}
          <button class="btn" ?disabled=${!(d.units >= 1)} @click=${() => this.setLay((x) => ([x.rows, x.cols] = suggestGrid(Math.round(x.units), x.w, x.d)))}>Suggest a grid</button>
        </div>
        ${Number.isFinite(d.w) && d.rows && d.cols ? html`<p class="small muted">Each circle is one unit. Units sit about ${(d.w / d.cols).toFixed(2)} x ${(d.d / d.rows).toFixed(2)} m apart.</p>` : nothing}
        ${d.units >= 1 && d.units <= 200 ? mapView(L, { items: [], label: `${plural(d.units, "unit")} in ${plural(d.rows, "row")}` }) : nothing}
        ${issues.map((i) => html`<div class="notice"><span>${i}</span></div>`)}
        ${notice(lostSensors, "sensor", `You'll place ${lostSensors.length > 1 ? "them" : "it"} again in the next step.`)}
        ${notice(lostVirt, "virtual device", `You'll place ${lostVirt.length > 1 ? "them" : "it"} again in the next step.`)}
        ${notice(movedOff, "device", `${movedOff.length > 1 ? "They come" : "It comes"} off the map unless you place ${movedOff.length > 1 ? "them" : "it"} again in the next step.`)}`;
    }
    if (d.step === 3) body = this.placement(d, z);
    const blocked = (d.step === 1 && issues.some((i) => i.startsWith("Width"))) || (d.step === 2 && issues.length > 0) || (d.step === 3 && lost.length > 0);
    const title = { 1: "Zone layout", 3: "Placement" }[d.flow[0] === 3 ? 3 : 1];
    return html`<div><h1>${title}: ${z.name}</h1></div>
      <section class="card">
        ${steps}${body}
        <div class="row">
          <button class="btn" @click=${this.layBack}>${at === 0 ? "Cancel" : "Back"}</button>
          <button class="btn primary" ?disabled=${blocked} @click=${this.layNext}>${last ? (changes ? "Review and apply" : "Finish") : "Next"}</button>
          ${d.step === 3 && lost.length ? html`<button class="fixlink" @click=${() => this.pickItem(lost[0].id)}>Place ${lost[0].name} to save &rsaquo;</button>` : nothing}
        </div>
      </section>`;
  }

  private placement(d: LayoutDraft, z: Zone) {
    const L = { w: d.w, d: d.d, units: d.units, rows: d.rows, cols: d.cols };
    const sel = itemOf(d, d.pick) ?? null;
    const where = (s: Item, missing: unknown) => (fits(s, L) ? html`<span class="small muted">${posText(s.pos as Spot, L)}</span>` : missing);
    const opt = (s: Item, missing: unknown) => html`<button class="sensor-opt" aria-pressed=${d.pick === s.id ? "true" : "false"} @click=${() => this.pickItem(s.id)}>
      <span class="opt-name">${mk(look(s))}${s.name}</span>${where(s, missing)}
    </button>`;
    const needs = html`<span class="pill high">Needs placing</span>`;
    const prompt = !sel
      ? "Pick a sensor or device."
      : sel.kind === "soil"
        ? `Tap the unit ${sel.name} is in.`
        : onMapOnly(sel.kind)
          ? `Tap a unit or any +, inside the wall or outside it, for ${sel.name}.`
          : `Tap a unit or any + inside the wall for ${sel.name}.`;
    const left = devsOff(d);
    return html`${d.sensors.length
        ? html`<div class="small muted">Sensors</div>
            <div class="sensor-list">${d.sensors.map((s) => opt(s, needs))}</div>`
        : html`<div class="notice"><strong>No sensors yet</strong><span>Map devices picks ${z.name}'s sensors from Home Assistant. Devices can be placed now.</span></div>`}
      ${d.devs.length
        ? html`<div class="small muted">Devices, optional</div>
            <div class="sensor-list">${d.devs.map((x) => opt(x, html`<span class="pill plain">Not placed</span>`))}</div>`
        : nothing}
      <div class="small muted">Virtual devices, not in Home Assistant</div>
      ${d.virt.length ? html`<div class="sensor-list">${d.virt.map((v) => opt(v, needs))}</div>` : nothing}
      <p class="small muted">Something worth seeing on the map that Home Assistant doesn't have, like a drain tank. It's only drawn: nothing reads or controls it.</p>
      <div class="row">
        <label class="field" for="lay-vname"
          >Add a virtual device<input
            id="lay-vname"
            type="text"
            maxlength="40"
            enterkeyhint="done"
            autocomplete="off"
            placeholder="For example Drain tank"
            .value=${d.vname}
            @input=${(e: Event) => this.setLay((x) => (x.vname = (e.target as HTMLInputElement).value))}
            @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.setLay(addVirtual)}
        /></label>
        <button class="btn" @click=${() => this.setLay(addVirtual)}>Add</button>
      </div>
      ${d.vissue ? html`<p class="small" role="status">${d.vissue}</p>` : nothing}
      <div class="now"><strong>${prompt}</strong></div>
      ${mapView(L, {
        items: this.layItems(d),
        picked: d.pick,
        placing: sel,
        onSpot: (p) => this.placeAt(p),
        onPick: (id) => this.pickItem(id),
        outer: true,
        label: sel ? `Places for ${sel.name}` : "Places for a sensor or device",
      })}
      ${sel?.kind === "env"
        ? html`<div class="now">
            ${this.chips(
              `Height of ${sel.name}`,
              `level-${sel.id}`,
              (Object.keys(LEVELS) as Level[]).map((k) => ({ value: k, label: LEVELS[k] })),
              sel.level ?? "",
              (v) => this.setLay((x) => {
                const s = itemOf(x, sel.id);
                if (s) s.level = v as Level;
              }),
            )}
          </div>`
        : sel?.kind === "soil"
          ? html`<div class="now"><strong>Height</strong><span class="small muted">Always at substrate height</span></div>`
          : nothing}
      ${sel?.kind === "device" && fits(sel, L)
        ? html`<div class="now"><strong>On the map</strong><button class="btn" @click=${() => this.setLay((x) => { const s = itemOf(x, sel.id); if (s) s.pos = null; })}>Take ${sel.name} off the map</button></div>`
        : nothing}
      ${sel?.kind === "virtual"
        ? html`<div class="now"><strong>Virtual device</strong><button class="btn" @click=${() => this.setLay((x) => { x.virt = x.virt.filter((v) => v.id !== sel.id); x.pick = null; })}>Remove ${sel.name}</button></div>`
        : nothing}
      ${keyView}
      ${left.length
        ? html`<div class="notice"><strong>${plural(left.length, "device")} ${left.length > 1 ? "aren't" : "isn't"} on the map</strong><span>${left.map((x) => x.name).join(", ")}. They don't need to be: placing a device is optional, and only placed devices show on ${z.name}'s map.</span></div>`
        : nothing}`;
  }

  private calibration(d: LeafDraft) {
    const z = this.zoneById(d.zoneId);
    if (!z) return nothing;
    const { raw, sensors, homesBy } = this.leafCtx(d.zoneId);
    const head = html`<div><h1>Sensor Calibration: ${z.name}</h1></div>`;
    const back = html`<button class="btn" ?disabled=${d.sending} @click=${this.leafExit}>Back</button>`;
    if (!sensors.length)
      return html`${head}<section class="card">
          <p class="muted">${z.name} has no environment sensors yet, and only those have a leaf temperature offset.</p>
          <div class="row">${back}<button class="btn" @click=${() => this.openMapDevices(z.id)}>Map devices</button></div>
        </section>`;
    if (!d.seeded)
      return html`${head}<section class="card">
          ${this.catalogError
            ? html`<div class="notice"><span>${this.catalogError}</span><button class="btn" @click=${this.askCatalog}>Try again</button></div>`
            : html`<p class="muted">Looking up ${z.name}'s boards in Home Assistant.</p>`}
          <div class="row">${back}</div>
        </section>`;
    const issues = leafIssues(d, sensors, homesBy), changes = this.leafChangeList(d).length;
    const open = z.setup.calibrate === "todo" || z.setup.calibrate === "later";
    const onBoard = sensors.some((s) => (homesBy[s.id] ?? []).length);
    const vpd = zoneVpdAt(d, sensors, this.methodOf(z.id), this.states, this.now), saved = this.zoneNow(z.id, "vpd").value;
    const level = (id: string) => {
      const x = (Array.isArray(raw?.sensors) ? raw.sensors : []).find((v) => typeof v === "object" && v !== null && (v as { id?: unknown }).id === id) as { level?: unknown } | undefined;
      return typeof x?.level === "string" && x.level in LEVELS ? LEVELS[x.level as Level] : "Height not set";
    };
    const counted = countedOf(sensors), basis = basisOf(sensors, d.basis);
    const chartAt = chartLeaf(d, sensors), at = Math.abs(chartAt) < 1e-9 ? "the leaf the same as air" : phrase(chartAt);
    const same = new Set(counted.map((s) => (d.rows[s.id] ? leafValue(d.rows[s.id]) : 0))).size === 1;
    return html`${head}
      ${open
        ? html`<div class="notice">
            Not confirmed yet. ${onBoard ? "Check each sensor's offset, then Confirm. A board keeps the offset it already holds, and one kept here starts at 0." : "Each offset starts at 0. Check them, then Confirm."}
            Applying a change confirms it too.
          </div>`
        : nothing}
      <section class="card" id="cal-leaf">
        <div>
          <h2>Leaf temperature offset</h2>
          <p class="muted small">How far leaf temperature sits from air temperature at each sensor. Only VPD uses it.</p>
        </div>
        <div class="now">
          <strong>${z.name} VPD ${vpd === null ? "--" : `${fmt("vpd", vpd)} kPa`}</strong>${vpd !== null && fmt("vpd", vpd) !== fmt("vpd", saved) ? html`<span class="small muted">Now ${fmt("vpd", saved)} kPa</span>` : nothing}
        </div>
        <div class="lrows">${repeat(sensors, (s) => s.id, (s) => this.leafRow(d, s, homesBy[s.id] ?? [], issues, level(s.id)))}</div>
        <div class="issues">
          ${issues.map((i) => html`<button class="notice fix" @click=${() => this.jumpToTarget(i.target)}><span>${i.text}</span><span class="fixgo">Fix &rsaquo;</span></button>`)}
        </div>
        ${counted.length >= 2
          ? html`<div class="lbasis">
              ${this.chips("VPD chart uses", `lbasis-${z.id}`, [{ value: "", label: "Average" }, ...counted.map((s) => ({ value: s.id, label: s.name }))], basis, (v) => this.setLeaf((x) => (x.basis = v)))}
              <div class="small muted">${same ? `Every sensor matches, so the chart is drawn at ${at}.` : `Drawn at ${at}. Each sensor's own VPD still uses its own offset.`}</div>
            </div>`
          : nothing}
        ${onBoard ? html`<p class="small muted">Offsets on a board are changed on the board itself. Its VPD, and anything reading it such as your alerts, follow straight away.</p>` : nothing}
      </section>
      <div class="row">
        ${back}${open && !changes ? html`<button class="btn primary" ?disabled=${issues.length > 0} @click=${this.leafConfirm}>Confirm</button>` : nothing}
      </div>`;
  }

  private leafRow(d: LeafDraft, s: ReturnType<typeof envSensors>[number], homes: Home[], issues: { id: string; target: string }[], height: string) {
    const r = d.rows[s.id];
    if (!r) return nothing;
    const h = homes.find((x) => x.entity === r.src), offline = !!h?.offline, locked = d.sending || offline || r.src === "";
    const L = limitsOf(r.src, homes), places = placesOf(L.step), bad = issues.some((i) => i.target === `lin-${s.id}`);
    const commit = (e: Event) => {
      const input = e.target as HTMLInputElement;
      this.setLeaf((x) => typeInto(x.rows[s.id], input.value));
      input.value = (this.leafw?.rows[s.id]?.mag ?? r.mag).toFixed(places);
    };
    const dir = (to: -1 | 1, label: string) =>
      html`<button aria-pressed=${r.dir === to ? "true" : "false"} ?disabled=${locked} @click=${() => this.setLeaf((x) => (x.rows[s.id].dir = to))}>${label}</button>`;
    const status = offline
      ? "This board is offline, so its offset can't change until it's back."
      : r.status === "sending"
        ? "Sending to the board..."
        : r.status === "stuck" && h
          ? `Not confirmed. The board still reports ${this.reported(h.entity)}.`
          : "";
    return html`<div class="lrow" id="lr-${s.id}">
      <div class="lrow-top"><strong>${s.name}</strong><span class="pill plain">${height}</span></div>
      ${homes.length
        ? html`<div id="lsrc-${s.id}">
            ${this.chips(
              `Where ${s.name}'s offset is held${r.src === "" ? ", pick one" : ""}`,
              `lsrc-${s.id}`,
              [...homes.map((x) => ({ value: x.entity, label: `On the board, ${x.name}` })), { value: KEPT, label: "Kept in Environment Control" }],
              r.src,
              (v) => this.setLeaf((x) => pickSrc(x.rows[s.id], s, v, homes)),
            )}
          </div>`
        : html`<div class="small muted">This sensor has nowhere to hold an offset, so it's kept in Environment Control.</div>`}
      <div class="lfield">
        <label class="lcell"
          ><input
            id="lin-${s.id}"
            data-lin=${s.id}
            type="text"
            inputmode="decimal"
            enterkeyhint="done"
            autocomplete="off"
            .value=${r.mag.toFixed(places)}
            aria-label="${s.name} degrees from air"
            aria-invalid=${bad ? "true" : "false"}
            ?disabled=${locked}
            @change=${commit}
            @keydown=${(e: KeyboardEvent) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          /><span>°C</span></label
        >
        <div class="seg" role="group" aria-label="${s.name} leaf against air">${dir(-1, "Below air")}${dir(1, "Above air")}</div>
      </div>
      <div class="small muted">${previewText(s, leafValue(r), this.states, this.now)}</div>
      ${r.src !== "" ? html`<div class="small muted">${h && h.name !== h.entity ? `${h.entity}. ` : ""}Between ${-L.min} °C below and ${L.max} °C above air, in steps of ${L.step}.</div>` : nothing}
      <div class="lstatus" role="status">${status}</div>
    </div>`;
  }

  /* Pinned to the foot of the window on a page edited freely, while anything differs from what's saved. */
  private draftBar() {
    const d = this.leafw;
    if (!d || this.screen !== "setup") return nothing;
    const changes = this.leafChangeList(d), n = changes.length;
    if (!n) return nothing;
    const z = this.zoneById(d.zoneId), { sensors, homesBy } = this.leafCtx(d.zoneId), issue = leafIssues(d, sensors, homesBy)[0];
    const blocked = issue ? `Fix first: ${issue.text}` : "";
    return html`<div class="draftbar" role="region" aria-label="Unsaved changes" ?inert=${!!this.modal} ?data-blocked=${!!blocked}>
      <span class="draft-count">${n}</span>
      <span class="draft-text"><strong>${n === 1 ? `${z?.name ?? ""} · ${changes[0].label}` : `${n} unsaved changes`}</strong><span class="draft-why"> · ${blocked || "nothing changes until you apply"}</span></span>
      <button class="draft-discard" ?disabled=${d.sending} @click=${this.leafDiscard}>Discard</button>
      <button class="draft-review" ?disabled=${!!blocked || d.sending} @click=${this.leafReview}>Review and apply</button>
    </div>`;
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
            <button role="menuitem" @click=${() => this.openLayoutWizard(z.id, [1, 2])}>Zone layout</button>
            <button role="menuitem" @click=${() => this.openLayoutWizard(z.id, [3])}>Placement</button>
            <button role="menuitem" @click=${() => this.openCalibration(z.id)}>Sensor Calibration</button>
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
    if (this.leafw) return this.calibration(this.leafw);
    if (this.wiz) return this.wizard(this.wiz);
    if (this.mapw) return this.mapWizard(this.mapw);
    if (this.lay) return this.layWizard(this.lay);
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
          ${m.error
            ? html`<div class="notice" role="alert">
                <strong>${m.refresh ? "Some changes were not applied." : "Not saved."}</strong>${m.error.split("\n").map((line) => html`<span>${line}</span>`)}
                ${m.refresh ? html`<span>Anything that went through is saved. What's left is still here to try again.</span>` : nothing}
              </div>`
            : nothing}
        </div>
        <div class="row">
          <button class="btn" ?disabled=${m.busy} @click=${() => this.closeModal()}>Back to editing</button>
          <button class="btn primary" ?disabled=${m.busy} @click=${this.applyReview}>${m.busy ? (m.busyText ?? "Saving...") : `Apply ${plural(n, "change")}`}</button>
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
      ${this.draftBar()}${this.modalView()}${this.toastText ? html`<div class="toast" role="status" aria-live="polite">${this.toastText}</div>` : nothing}`;
  }
}

if (!customElements.get("ec-app")) customElements.define("ec-app", EcApp);
