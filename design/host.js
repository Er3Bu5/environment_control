"use strict";
/* The panel element Home Assistant mounts, and the only code that holds your login. The whole UI runs in a sandboxed
   frame with its own origin and no network, and this element is its only way out: it hands the frame the states of
   mapped entities and runs the few actions in the v1 write table, looking every entity up in the config it fetched
   itself. The frame sends ids, never an entity or a service, and anything not on the allowlist is dropped.
   Kept small and dependency-free on purpose, because it runs with full trust. */
(() => {
  const WRITE_DOMAINS = ["switch", "light", "fan", "humidifier"];
  const ACTIONS = ["turn_on", "turn_off", "brightness", "mode", "humidity"];
  /* Only what the UI draws. Anything else an integration puts in its attributes stays here. */
  const ATTRS = ["friendly_name", "brightness", "supported_color_modes", "mode", "available_modes", "humidity", "current_humidity", "min_humidity", "max_humidity", "min", "max", "step", "unit_of_measurement"];
  const isId = (v) => typeof v === "string" && /^[a-z0-9_-]{1,64}$/.test(v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  class EnvironmentControlPanel extends HTMLElement {
    constructor() {
      super();
      this.shadow = this.attachShadow({ mode: "closed" });
      this.forwarded = {};
      this.onMessage = this.onMessage.bind(this);
    }
    set hass(h) {
      const first = !this._hass;
      this._hass = h;
      if (first) this.start(); else this.forward();
    }
    get hass() { return this._hass; }
    disconnectedCallback() {
      window.removeEventListener("message", this.onMessage);
      if (this.onReady) this._hass.connection.removeEventListener("ready", this.onReady);
    }

    async start() {
      if (!this._hass.user || !this._hass.user.is_admin) { this.shadow.textContent = "Environment Control is for admins."; return; }
      /* HA reconnects after a restart without reloading this page, so what's stored is read again then. */
      if (!this.onReady) { this.onReady = () => this.reload(); this._hass.connection.addEventListener("ready", this.onReady); }
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
      this.frame.srcdoc = this.ui;
      window.addEventListener("message", this.onMessage);
      this.shadow.append(style, this.frame);
    }

    mapped() {
      const out = new Set();
      for (const d of this.config.devices) if (d.entity && d.zones.length) out.add(d.entity);
      return out;
    }
    pick(st) {
      if (!st) return null;
      const attributes = {};
      for (const k of ATTRS) if (k in st.attributes) attributes[k] = st.attributes[k];
      const c = st.context || {};
      return { state: String(st.state), attributes, by: c.user_id ? "user" : c.parent_id ? "automation" : "device" };
    }
    theme() { return this._hass.themes && this._hass.themes.darkMode ? "dark" : "light"; }
    post(msg) { if (this.frame && this.frame.contentWindow) this.frame.contentWindow.postMessage({ v: 1, ...msg }, "*"); }

    init() {
      const states = {};
      for (const e of this.mapped()) { states[e] = this.pick(this._hass.states[e]); this.forwarded[e] = JSON.stringify(states[e]); }
      this.sentTheme = this.theme();
      this.post({ type: "init", ...this.stored(), states, theme: this.sentTheme });
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
      const changed = {};
      for (const e of this.mapped()) {
        const now = this.pick(this._hass.states[e]), key = JSON.stringify(now);
        if (this.forwarded[e] !== key) { changed[e] = now; this.forwarded[e] = key; }
      }
      if (Object.keys(changed).length) this.post({ type: "states", states: changed });
      if (this.theme() !== this.sentTheme) { this.sentTheme = this.theme(); this.post({ type: "theme", theme: this.sentTheme }); }
    }

    onMessage(e) {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const m = e.data;
      if (!m || typeof m !== "object" || m.v !== 1 || typeof m.type !== "string") return;
      if (m.type === "ready") this.init();
      else if (m.type === "device") this.device(m);
      else if (m.type === "save") this.save(m);
    }
    reply(req, ok, error) { if (Number.isInteger(req)) this.post({ type: "result", req, ok, ...(error ? { error } : {}) }); }

    /* The v1 write table's device rows. Everything is checked against this element's own copy of the config and HA's
       own state, so a frame that names a device it shouldn't, or a value the device can't take, gets nothing sent. */
    async device(m) {
      const refuse = (why) => this.reply(m.req, false, why);
      if (!isId(m.id) || !ACTIONS.includes(m.action)) return refuse("Not a device or action this panel knows.");
      const d = this.config.devices.find((x) => x.id === m.id);
      if (!d || !d.entity || !d.zones.length) return refuse("That device isn't mapped to a zone.");
      const entity = d.entity, domain = entity.split(".")[0], st = this._hass.states[entity];
      if (!WRITE_DOMAINS.includes(domain)) return refuse("This panel doesn't control that kind of entity.");
      if (!st) return refuse(`Home Assistant has no ${entity}.`);
      if (st.state === "unavailable") return refuse("It's unavailable in Home Assistant.");
      const a = st.attributes, target = { entity_id: entity };
      let call = null;
      if (m.action === "turn_on" || m.action === "turn_off") call = [domain, m.action, target];
      else if (m.action === "brightness" && domain === "light" && (a.supported_color_modes || []).some((c) => c !== "onoff") && Number.isInteger(m.value) && m.value >= 1 && m.value <= 100) call = ["light", "turn_on", { ...target, brightness_pct: m.value }];
      else if (m.action === "mode" && domain === "humidifier" && typeof m.value === "string" && (a.available_modes || []).includes(m.value)) call = ["humidifier", "set_mode", { ...target, mode: m.value }];
      else if (m.action === "humidity" && domain === "humidifier" && isNum(m.value) && m.value >= a.min_humidity && m.value <= a.max_humidity) call = ["humidifier", "set_humidity", { ...target, humidity: m.value }];
      if (!call) return refuse("That value isn't one this device takes.");
      try {
        await this._hass.callService(...call);
        this.reply(m.req, true);
      } catch (err) {
        refuse(String((err && err.message) || err));
      }
    }

    /* Setup changes only this integration's own storage, through its backend, which checks the whole config and the
       revision it was based on. The host keeps the backend's answer, never the frame's copy, as its config. */
    async save(m) {
      const refuse = (why) => this.reply(m.req, false, why);
      if (!Number.isInteger(m.base) || !m.config || typeof m.config !== "object") return refuse("That isn't a setup this panel can save.");
      if (JSON.stringify(m.config).length > 512 * 1024) return refuse("That setup is too large to save.");
      try {
        this.config = await this._hass.connection.sendMessagePromise({ type: "environment_control/config/save", revision: m.base, config: { zones: m.config.zones, devices: m.config.devices } });
      } catch (err) {
        return refuse(String((err && err.message) || err));
      }
      this.post({ type: "result", req: m.req, ok: true, ...this.stored() });
      this.forward();
    }
  }
  if (!customElements.get("environment-control-panel")) customElements.define("environment-control-panel", EnvironmentControlPanel);
})();
