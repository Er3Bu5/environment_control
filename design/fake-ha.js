"use strict";
/* Stands in for Home Assistant on a dev machine, so the panel can be proven before it touches a real room.
   It hands the panel element a hass object shaped like the real one: states, callService and a connection for the
   panel's own commands. It behaves like this room where that matters: devices report a moment after a command,
   a Tuya plug can drop one silently, failsafes put some devices back, and a service refuses what HA would refuse. */
class FakeHA {
  constructor(seed) {
    this.states = JSON.parse(JSON.stringify(seed.states));
    this.config = JSON.parse(JSON.stringify(seed.config));
    this.failsafes = seed.failsafes || {};
    this.registry = seed.registry || { entities: {}, areas: {} };
    this.knobs = { reportMs: 600, dropNext: false, dropAll: false, failsafeMs: 1000, watchdogMs: 3000, cutPower: false, restartMs: 1500, ignore: new Set() };
    this.calls = [];
    this.saves = [];
    this.panels = new Set();
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.readyListeners = new Set();
    this.darkMode = false;
    this.running = true;
    /* .storage/environment_control. A save replaces it whole or not at all, as HA's atomic writes do. */
    this.disk = JSON.stringify(this.config);
    const ha = this;
    this.connection = {
      sendMessagePromise: (msg) => ha.command(msg),
      addEventListener: (type, fn) => { if (type === "ready") ha.readyListeners.add(fn); },
      removeEventListener: (type, fn) => { if (type === "ready") ha.readyListeners.delete(fn); },
    };
  }

  attach(panel) { this.panels.add(panel); panel.hass = this.hass(); }
  detach(panel) { this.panels.delete(panel); }
  onCall(fn) { this.listeners.add(fn); }
  onStatus(fn) { this.statusListeners.add(fn); }
  status(text) { for (const fn of this.statusListeners) fn(text); }
  hass() {
    return {
      states: this.states,
      user: { is_admin: true },
      themes: { darkMode: this.darkMode },
      entities: this.registry.entities,
      areas: this.registry.areas,
      callService: (domain, service, data) => this.callService(domain, service, data),
      connection: this.connection,
    };
  }
  /* HA gives the panel a new hass object on every change, never a mutated one. */
  publish() { this.states = { ...this.states }; for (const p of this.panels) p.hass = this.hass(); }
  setState(entity, state, attributes, context) {
    const was = this.states[entity];
    this.states[entity] = { entity_id: entity, state, attributes: { ...(was ? was.attributes : {}), ...(attributes || {}) }, context: context || { user_id: null, parent_id: null } };
    this.publish();
    this.watch(entity, was && was.state);
  }
  setDark(dark) { this.darkMode = dark; this.publish(); }

  /* A failsafe here acts within seconds, where yours take 1 second (mains and fans) or up to 2 minutes (the light watchdogs). */
  watch(entity, was) {
    const f = this.failsafes[entity], now = this.states[entity];
    if (!f || !now || now.state === f.want || now.state === "unavailable" || was === now.state) return;
    clearTimeout(f.timer);
    f.timer = setTimeout(() => {
      const s = this.states[entity];
      if (s && s.state !== f.want && s.state !== "unavailable") this.setState(entity, f.want, f.want === "off" && entity.startsWith("light.") ? { brightness: null } : {}, { user_id: null, parent_id: f.by });
    }, f.kind === "watchdog" ? this.knobs.watchdogMs : this.knobs.failsafeMs);
  }

  fail(msg) { const e = new Error(msg); e.code = "invalid_format"; throw e; }
  /* What HA itself checks before a service runs. The panel's host checks first, so reaching one of these is a host bug. */
  validate(domain, service, data) {
    const entity = data && data.entity_id, s = this.states[entity];
    if (typeof entity !== "string" || !s) this.fail(`Entity ${entity} not found`);
    if (entity.split(".")[0] !== domain) this.fail(`${domain}.${service} can't act on ${entity}`);
    const a = s.attributes, num = (v) => typeof v === "number" && Number.isFinite(v);
    const key = `${domain}.${service}`;
    const known = ["switch.turn_on", "switch.turn_off", "fan.turn_on", "fan.turn_off", "light.turn_on", "light.turn_off", "humidifier.turn_on", "humidifier.turn_off", "humidifier.set_mode", "humidifier.set_humidity", "number.set_value", "input_number.set_value", "input_datetime.set_datetime"];
    if (!known.includes(key)) this.fail(`Service ${key} not found`);
    if (key === "light.turn_on" && data.brightness_pct !== undefined && !(num(data.brightness_pct) && data.brightness_pct >= 0 && data.brightness_pct <= 100)) this.fail(`Value ${data.brightness_pct} for brightness_pct is out of range`);
    if (key === "humidifier.set_mode" && !(a.available_modes || []).includes(data.mode)) this.fail(`Mode ${data.mode} is not one of ${(a.available_modes || []).join(", ")}`);
    if (key === "humidifier.set_humidity" && !(num(data.humidity) && data.humidity >= a.min_humidity && data.humidity <= a.max_humidity)) this.fail(`Humidity ${data.humidity} is outside ${a.min_humidity} to ${a.max_humidity}`);
    if (key.endsWith(".set_value")) {
      const v = data.value, off = num(v) ? Math.abs(((v - a.min) / a.step) - Math.round((v - a.min) / a.step)) : 1;
      if (!num(v) || v < a.min || v > a.max || off > 1e-6) this.fail(`Value ${v} for ${entity} must be ${a.min} to ${a.max} in steps of ${a.step}`);
    }
    if (key === "input_datetime.set_datetime" && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(data.time))) this.fail(`Time ${data.time} is not valid`);
  }
  outcome(domain, service, data, s) {
    const a = s.attributes;
    switch (`${domain}.${service}`) {
      case "light.turn_on": return ["on", { brightness: data.brightness_pct === undefined ? (a.brightness || 255) : Math.round((data.brightness_pct / 100) * 255) }];
      case "light.turn_off": return ["off", { brightness: null }];
      case "humidifier.set_mode": return [s.state, { mode: data.mode }];
      case "humidifier.set_humidity": return [s.state, { humidity: data.humidity }];
      case "input_datetime.set_datetime": return [String(data.time).length === 5 ? `${data.time}:00` : String(data.time), {}];
      case "number.set_value": return [Number(data.value).toFixed(1), {}];
      default: return service === "turn_on" ? ["on", {}] : service === "turn_off" ? ["off", {}] : [String(data.value), {}];
    }
  }
  down() { const e = new Error("Lost connection to Home Assistant"); e.code = "connection_lost"; throw e; }
  async callService(domain, service, data) {
    if (!this.running) this.down();
    this.validate(domain, service, data);
    const entity = data.entity_id, s = this.states[entity];
    if (s.state === "unavailable") { const e = new Error(`${entity} is unavailable`); e.code = "home_assistant_error"; throw e; }
    const call = { domain, service, data: { ...data }, dropped: this.knobs.dropAll || this.knobs.dropNext || this.knobs.ignore.has(entity) };
    this.calls.push(call); this.knobs.dropNext = false;
    for (const fn of this.listeners) fn(call);
    /* HA accepts a call a Tuya plug then ignores, so a dropped command still returns success. */
    if (call.dropped) return { context: { id: `c${this.calls.length}` } };
    const [state, attrs] = this.outcome(domain, service, data, s);
    setTimeout(() => { if (this.states[entity].state !== "unavailable") this.setState(entity, state, attrs, { user_id: "you", parent_id: null }); }, this.knobs.reportMs);
    return { context: { id: `c${this.calls.length}` } };
  }

  /* The panel's own backend commands. */
  async command(msg) {
    if (!this.running) this.down();
    if (!msg || typeof msg.type !== "string") this.fail("Bad message");
    if (msg.type === "environment_control/config") return JSON.parse(JSON.stringify(this.config));
    if (msg.type === "environment_control/config/save") return this.save(msg);
    this.fail(`Unknown command ${msg.type}`);
  }
  /* The real backend checks every field against a schema. This checks enough to catch a host that forwards junk. */
  checkConfig(c) {
    /* A spot on a zone's map is on the half-steps, from outside the wall on one side to outside it on the other. */
    const spotOk = (p, L) => !!L && Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isInteger(x * 2)) && p[0] >= -1 && p[0] <= L.rows && p[1] >= -1 && p[1] <= L.cols;
    const ok = c && Array.isArray(c.zones) && Array.isArray(c.devices) && c.zones.length <= 20 && c.devices.length <= 200;
    if (!ok) this.fail("Config isn't zones and devices");
    const ids = new Set(c.zones.map((z) => z.id));
    if (ids.size !== c.zones.length || c.zones.some((z) => typeof z.id !== "string" || !/^[a-z0-9_]{1,40}$/.test(z.id))) this.fail("Zone ids must be unique slugs");
    const helper = (v) => v === undefined || (typeof v === "string" && /^input_(number|datetime)\.[a-z0-9_]+$/.test(v)) || (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(helper));
    for (const z of c.zones) if (z.helpers !== undefined && !helper(z.helpers)) this.fail(`${z.id} links a setting to something that isn't a helper`);
    const flat = (v) => (v === undefined ? [] : typeof v === "string" ? [v] : Object.values(v).flatMap(flat));
    for (const z of c.zones) {
      const h = z.helpers || {};
      if ([h.day, h.night].some((e) => e !== undefined && !e.startsWith("input_datetime."))) this.fail(`${z.id} links lights on or off to something that isn't a time helper`);
      if ([h.morning, h.daylight, h.evening, ...flat(h.bands), ...flat(h.light)].some((e) => e !== undefined && !e.startsWith("input_number."))) this.fail(`${z.id} links a number setting to something that isn't a number helper`);
    }
    const onOff = (list) => list === undefined || (Array.isArray(list) && list.length <= 20 && list.every((e) => typeof e === "string" && /^(switch|light|input_boolean)\.[a-z0-9_]+$/.test(e)));
    for (const z of c.zones) {
      if (z.emersonMode !== undefined && !["none", "helper", "fixed", "detected"].includes(z.emersonMode)) this.fail(`${z.id} has a red light source this panel doesn't know`);
      if (z.emersonMode === "fixed" && !["morning", "daylight", "evening"].every((k) => { const n = (z.emerson || {})[k]; return Number.isInteger(n) && n >= 0 && n <= 59; })) this.fail(`${z.id} has red light extensions outside 0 to 59 minutes`);
      if (!onOff(z.lights) || !onOff(z.redLights)) this.fail(`${z.id} follows something that isn't an on or off entity`);
    }
    for (const z of c.zones) if (z.description !== undefined && (typeof z.description !== "string" || !z.description.trim() || z.description.length > 200)) this.fail(`${z.id} has a description that isn't short text`);
    for (const z of c.zones) for (const x of z.sensors || []) if (x.leafEntity !== undefined && !/^number\.[a-z0-9_]+$/.test(x.leafEntity)) this.fail(`${x.id} has a leaf temperature offset that isn't a number entity`);
    for (const d of c.devices) {
      if (!Array.isArray(d.zones) || d.zones.some((z) => !ids.has(z))) this.fail(`${d.id} is in a zone that doesn't exist`);
      if (d.entity !== undefined && !/^(switch|light|fan|humidifier)\.[a-z0-9_]+$/.test(d.entity)) this.fail(`${d.id} has an entity this panel can't control`);
      /* A device's spot on each zone's map: half-steps, from the wall gap on one side to the wall gap on the other. */
      if (d.place === undefined) continue;
      if (!d.place || typeof d.place !== "object" || Array.isArray(d.place)) this.fail(`${d.id} has a placement that isn't per zone`);
      for (const [zid, p] of Object.entries(d.place)) {
        const z = c.zones.find((x) => x.id === zid), L = z && z.layout;
        if (!d.zones.includes(zid) || !L) this.fail(`${d.id} is placed in a zone it isn't in`);
        if (!spotOk(p, L)) this.fail(`${d.id} is placed outside ${zid}'s map`);
      }
    }
    /* Virtual devices are only drawn: a name and a spot, nothing that names an entity. */
    for (const z of c.zones) {
      if (z.virtual === undefined) continue;
      if (!Array.isArray(z.virtual) || z.virtual.length > 30) this.fail(`${z.id} has virtual devices that aren't a short list`);
      const vids = new Set();
      for (const v of z.virtual) {
        const shape = v && typeof v === "object" && Object.keys(v).every((k) => ["id", "name", "pos", "type"].includes(k));
        if (!shape || typeof v.id !== "string" || !/^v-[a-z0-9_]{1,40}$/.test(v.id) || vids.has(v.id) || typeof v.name !== "string" || !v.name.trim() || v.name.length > 40) this.fail(`${z.id} has a virtual device that isn't a name and a spot`);
        vids.add(v.id);
        if (!spotOk(v.pos, z.layout)) this.fail(`${v.id} is placed outside ${z.id}'s map`);
      }
    }
  }
  /* Revision-checked, so a save made from a stale copy can't undo someone else's. */
  save(msg) {
    if (msg.revision !== this.config.revision) this.fail("Setup was saved from somewhere else since this was opened. Reopen the panel to see it.");
    this.checkConfig(msg.config);
    const next = { ...JSON.parse(JSON.stringify(msg.config)), revision: this.config.revision + 1 };
    this.saves.push({ revision: next.revision, cut: this.knobs.cutPower });
    if (this.knobs.cutPower) {
      /* The power goes before the new file lands, so the old one is what HA finds when it comes back. */
      this.knobs.cutPower = false;
      this.powerCut();
      this.down();
    }
    this.config = next;
    this.disk = JSON.stringify(next);
    return JSON.parse(this.disk);
  }
  /* What HA has in memory goes, and what's on disk comes back. Device states survive, as HA restores them. */
  restart() {
    this.running = false;
    this.status("Home Assistant is restarting");
    setTimeout(() => this.boot(), this.knobs.restartMs);
  }
  powerCut() {
    this.running = false;
    this.status("Power cut. Home Assistant is starting up again");
    setTimeout(() => this.boot(), this.knobs.restartMs);
  }
  boot() {
    this.config = JSON.parse(this.disk);
    this.running = true;
    this.status("");
    this.publish();
    for (const fn of this.readyListeners) fn();
  }

  offline(entity, down) {
    const s = this.states[entity]; if (!s) return;
    this.held = this.held || {};
    if (down) { if (s.state !== "unavailable") this.held[entity] = s.state; this.setState(entity, "unavailable"); }
    else if (s.state === "unavailable") this.setState(entity, this.held[entity] || "off");
  }
}
