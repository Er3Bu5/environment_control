// @ts-check
/* The panel element Home Assistant mounts, and the only code that holds your login. The whole UI runs in a sandboxed
   frame with its own origin and no network, and this element is its only way out: it hands the frame the stored setup,
   the states of mapped entities with allowlisted attributes, and HA's theme colours, each checked to be a plain colour.
   Anything the frame sends that isn't on the allowlist is dropped.

   This release moves nothing: there is no service call here. Device controls, calibration and setting writes arrive in
   the releases that use them, each checked here against the setup this element fetched itself, never the frame's copy.
   Kept small and dependency-free on purpose, because it runs with full trust, and shipped exactly as written. */
import FRAME_HTML from "./frame.js";

/* Only what the UI draws. Anything else an integration puts in its attributes stays here. */
const ATTRS = ["friendly_name", "brightness", "supported_color_modes", "mode", "available_modes", "humidity", "current_humidity", "min_humidity", "max_humidity", "min", "max", "step", "unit_of_measurement"];
const HELPER = /^input_(number|datetime)\.[a-z0-9_]{1,200}$/;
/* The settings a zone can link to a helper. */
const SETTINGS = ["day", "night", "morning", "daylight", "evening", "light.dayMin", "light.nightMax",
  ...["day", "night"].flatMap((p) => ["temperature", "humidity", "vpd"].flatMap((k) => ["min", "target", "max"].map((slot) => `bands.${p}.${k}.${slot}`)))];
/** @param {any} z @param {string} name */
const linkAt = (z, name) => name.split(".").reduce((o, key) => (o && typeof o === "object" ? o[key] : undefined), z.helpers || {});
/** @param {any} z */
const helperLinks = (z) => SETTINGS.map((n) => linkAt(z, n)).filter((e) => typeof e === "string" && HELPER.test(e));
/* HA's own theme colours, read from this element where HA's theme lands, each the first of its names that holds a plain
   colour. Anything else, such as a url() or a value carrying a semicolon, is left behind and the frame keeps its own. */
/** @type {Record<string, string[]>} */
const HA_COLORS = { primary: ["--primary-color"], bg: ["--primary-background-color"], card: ["--ha-card-background", "--card-background-color"],
  tile: ["--secondary-background-color"], fg: ["--primary-text-color"], muted: ["--secondary-text-color"], line: ["--divider-color"] };
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,20})$/i;
/* Appearance is per device, as HA's own theme choice is, so it lives in this browser rather than in the panel's storage. */
const APPEARANCES = ["ha", "light", "dark"], APPEARANCE_KEY = "environment-control-appearance";
/* HA's own test for a click it turns into a page change (isNavigationClick in its frontend): a plain left click on a
   same-origin link with no target. HA leaves a click alone once something has cancelled it, which is how this holds the
   page. Its sidebar entries are links like this, inside open shadow roots, so they show in the click's path. */
/** @param {MouseEvent} e @returns {HTMLAnchorElement | null} */
const leavingVia = (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  const a = /** @type {HTMLAnchorElement | undefined} */ (e.composedPath().find((n) => /** @type {Element} */ (n).tagName === "A"));
  if (!a || a.target || a.hasAttribute("download") || a.getAttribute("rel") === "external") return null;
  let url;
  try { url = new URL(a.href); } catch { return null; }
  if (url.origin !== location.origin) return null;
  return url.pathname + url.search + url.hash === location.pathname + location.search + location.hash ? null : a;
};
/** @param {string} tag @param {string} [text] @param {string} [cls] */
const make = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const DIALOG_CSS = `dialog{max-width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 32px);box-sizing:border-box;border:0;border-radius:16px;padding:20px;font:15px/1.45 Roboto,system-ui,sans-serif;background:#FFFFFF;color:#212121;box-shadow:0 12px 40px rgba(0,0,0,.35)}
  dialog.dark{background:#1C1C1C;color:#E1E1E1}dialog::backdrop{background:rgba(0,0,0,.55)}
  h2{margin:0 0 6px;font-size:19px;font-weight:500;outline:none}p{margin:0 0 12px;opacity:.8;font-size:14px}
  .row{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}button{font:inherit;font-size:14px;min-height:40px;padding:0 16px;border-radius:20px;border:1px solid rgba(128,128,128,.5);background:none;color:inherit;cursor:pointer}
  button.leave{color:#D32F2F;border-color:#D32F2F}dialog.dark button.leave{color:#EF9A9A;border-color:#EF9A9A}`;

class EnvironmentControlPanel extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "closed" });
    /** @type {Record<string, string>} */
    this.forwarded = {};
    /** @type {any} */
    this._hass = null;
    /** @type {any} */
    this.config = null;
    /** @type {HTMLIFrameElement | null} */
    this.frame = null;
    this.ready = false;
    this.draftOpen = false;
    this.passing = false;
    this.asking = false;
    /** @type {string | null} */
    this.picked = null;
    /** @type {string | undefined} */
    this.sentTheme = undefined;
    /** @type {(() => void) | null} */
    this.onReady = null;
    this.onMessage = this.onMessage.bind(this);
    /* The frame has no allow-modals, so it can't ask before the page closes. It says whether a draft is open, and this
       raises the browser's own leave prompt instead. The worst a compromised frame can do with that is ask needlessly. */
    /** @param {BeforeUnloadEvent} e */
    this.onUnload = (e) => { if (this.draftOpen) { e.preventDefault(); e.returnValue = ""; } };
    /* HA's sidebar changes pages without unloading this one, so the browser never asks. A link click that would take HA
       elsewhere is held here first, before HA's own listener, and goes ahead only once you say so. */
    /** @param {MouseEvent} e */
    this.onClick = (e) => {
      if (!this.draftOpen || this.passing) return;
      const link = leavingVia(e);
      if (!link) return;
      e.preventDefault();
      if (this.asking) return;
      this.askLeave().then((go) => {
        if (!go) return;
        /* The same link clicked again, so HA changes page its own way. */
        this.passing = true;
        try { link.click(); } finally { this.passing = false; }
      });
    };
  }
  set hass(h) {
    const first = !this._hass;
    this._hass = h;
    if (first) this.start(); else this.forward();
  }
  get hass() { return this._hass; }
  disconnectedCallback() {
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("beforeunload", this.onUnload);
    window.removeEventListener("click", this.onClick, true);
    this.draftOpen = false;
    if (this.onReady) this._hass.connection.removeEventListener("ready", this.onReady);
  }

  async start() {
    if (!this._hass.user || !this._hass.user.is_admin) { this.shadow.textContent = "Environment Control is for admins."; return; }
    /* HA reconnects after a restart without reloading this page, so what's stored is read again then. */
    if (!this.onReady) { this.onReady = () => { this.reload(); }; this._hass.connection.addEventListener("ready", this.onReady); }
    try {
      this.config = await this._hass.connection.sendMessagePromise({ type: "environment_control/config" });
    } catch {
      this.shadow.textContent = "Can't reach Home Assistant. This panel opens when it's back.";
      return;
    }
    this.shadow.textContent = "";
    const style = document.createElement("style");
    style.textContent = ":host{display:block;height:100%}iframe{display:block;width:100%;height:100%;border:0}";
    this.frame = document.createElement("iframe");
    /* allow-scripts alone: adding allow-same-origin would let the frame reach this page and undo the sandbox. */
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.setAttribute("title", "Environment Control");
    this.frame.srcdoc = FRAME_HTML;
    window.addEventListener("message", this.onMessage);
    window.addEventListener("beforeunload", this.onUnload);
    window.addEventListener("click", this.onClick, true);
    this.shadow.append(style, this.frame);
  }

  mapped() {
    const out = new Set();
    for (const d of this.config.devices || []) if (d && typeof d.entity === "string" && Array.isArray(d.zones) && d.zones.length) out.add(d.entity);
    for (const z of this.config.zones || []) for (const x of z.sensors || []) if (x && typeof x.leafEntity === "string" && !x.leafUnused) out.add(x.leafEntity);
    for (const z of this.config.zones || []) for (const e of helperLinks(z)) out.add(e);
    return out;
  }
  /** @param {any} st */
  pick(st) {
    if (!st) return null;
    /** @type {Record<string, unknown>} */
    const attributes = {};
    for (const k of ATTRS) if (k in st.attributes) attributes[k] = st.attributes[k];
    const c = st.context || {};
    return { state: String(st.state), attributes, by: c.user_id ? "user" : c.parent_id ? "automation" : "device" };
  }
  appearance() {
    let v = this.picked;
    if (!v) try { v = localStorage.getItem(APPEARANCE_KEY); } catch { /* No storage, so Home Assistant until one is picked. */ }
    return v && APPEARANCES.includes(v) ? v : "ha";
  }
  /* Light and Dark are the panel's own palettes. Home Assistant takes HA's dark mode and HA's colours, so the panel matches
     whatever theme and primary colour you've picked there. */
  theme() {
    const appearance = this.appearance();
    /** @type {Record<string, string>} */
    const colors = {};
    if (appearance !== "ha") return { appearance, mode: appearance, colors };
    const css = getComputedStyle(this);
    for (const [k, names] of Object.entries(HA_COLORS)) {
      const c = names.map((n) => css.getPropertyValue(n).trim()).find(Boolean);
      if (c && COLOR.test(c)) colors[k] = c;
    }
    return { appearance, mode: this._hass.themes && this._hass.themes.darkMode ? "dark" : "light", colors };
  }
  /** @param {any} m */
  setAppearance(m) {
    if (!APPEARANCES.includes(m.value)) { this.reply(m.req, false, "Not an appearance."); return; }
    /* Held here too, so a browser that blocks storage keeps the choice until the panel closes. */
    this.picked = m.value;
    try { localStorage.setItem(APPEARANCE_KEY, m.value); } catch { /* Kept for this visit only. */ }
    this.reply(m.req, true);
    this.sendTheme();
  }
  /** @param {boolean} [force] */
  sendTheme(force) {
    const t = this.theme(), key = JSON.stringify(t);
    if (force || key !== this.sentTheme) { this.sentTheme = key; if (!force) this.post({ type: "theme", theme: t }); }
    return t;
  }
  /** @param {Record<string, unknown>} msg */
  post(msg) { if (this.frame && this.frame.contentWindow) this.frame.contentWindow.postMessage({ v: 1, ...msg }, "*"); }

  init() {
    /** @type {Record<string, unknown>} */
    const states = {};
    for (const e of this.mapped()) { states[e] = this.pick(this._hass.states[e]); this.forwarded[e] = JSON.stringify(states[e]); }
    this.post({ type: "init", ...this.stored(), states, theme: this.sendTheme(true) });
    this.ready = true;
  }
  stored() { return { revision: this.config.revision, zones: this.config.zones, devices: this.config.devices }; }
  async reload() {
    if (!this.frame) { this.start(); return; }
    try { this.config = await this._hass.connection.sendMessagePromise({ type: "environment_control/config" }); } catch { return; }
    if (this.ready) { this.post({ type: "config", ...this.stored() }); this.forward(); }
  }
  forward() {
    if (!this.ready) return;
    /** @type {Record<string, unknown>} */
    const changed = {};
    for (const e of this.mapped()) {
      const now = this.pick(this._hass.states[e]), key = JSON.stringify(now);
      if (this.forwarded[e] !== key) { changed[e] = now; this.forwarded[e] = key; }
    }
    if (Object.keys(changed).length) this.post({ type: "states", states: changed });
    this.sendTheme();
  }

  /** @param {MessageEvent} e */
  onMessage(e) {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.v !== 1 || typeof m.type !== "string") return;
    /* A frame that has just loaded holds no draft. */
    if (m.type === "ready") { this.draftOpen = false; this.init(); }
    else if (m.type === "draft") { if (typeof m.open === "boolean") this.draftOpen = m.open; }
    else if (m.type === "appearance") this.setAppearance(m);
  }
  /** @param {unknown} req @param {boolean} ok @param {string} [error] */
  reply(req, ok, error) { if (Number.isInteger(req)) this.post({ type: "result", req, ok, ...(error ? { error } : {}) }); }

  /** @returns {Promise<boolean>} */
  askLeave() {
    this.asking = true;
    return new Promise((resolve) => {
      const t = this.theme(), dlg = /** @type {HTMLDialogElement} */ (make("dialog", undefined, t.mode));
      dlg.setAttribute("aria-labelledby", "ec-leave-title");
      const title = make("h2", "Discard unsaved changes?");
      title.id = "ec-leave-title"; title.tabIndex = -1;
      const keep = make("button", "Keep editing"), leave = make("button", "Discard and leave", "leave");
      keep.dataset.host = "keep"; leave.dataset.host = "leave";
      const row = make("div", undefined, "row"); row.append(keep, leave);
      dlg.append(make("style", DIALOG_CSS), title, make("p", "Environment Control has changes you haven't applied. Leaving discards them, and nothing is sent to Home Assistant."), row);
      /** @param {boolean} yes */
      const finish = (yes) => { dlg.close(); dlg.remove(); this.asking = false; resolve(yes); };
      keep.addEventListener("click", () => finish(false));
      leave.addEventListener("click", () => finish(true));
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
      this.shadow.append(dlg);
      dlg.showModal();
      title.focus();
    });
  }
}
if (!customElements.get("environment-control-panel")) customElements.define("environment-control-panel", EnvironmentControlPanel);
