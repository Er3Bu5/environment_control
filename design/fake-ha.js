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
    /* HA's device registry: an entity with no area of its own is in its device's. */
    this.registry.devices = this.registry.devices || {};
    this.activity = seed.activity || { now: new Date().toISOString(), earliest: {}, entries: {} };
    this.activityCalls = [];
    this.knobs = { reportMs: 600, dropNext: false, dropAll: false, activityMs: 300, activity: null, failsafeMs: 1000, watchdogMs: 3000, cutPower: false, restartMs: 1500, ignore: new Set(), steps: {}, targetModes: {} };
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
      devices: this.registry.devices,
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
    const known = ["automation.turn_on", "automation.turn_off", "switch.turn_on", "switch.turn_off", "fan.turn_on", "fan.turn_off", "light.turn_on", "light.turn_off", "humidifier.turn_on", "humidifier.turn_off", "humidifier.set_mode", "humidifier.set_humidity", "number.set_value", "input_number.set_value", "input_datetime.set_datetime"];
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
  /* A light controller can round to its own steps on the device, as yours do to 5% with a floor: it then only ever
     reports the rounded number, never the one asked. knobs.steps[entity] = { step, floor }, in percent. */
  snapped(entity, pct) {
    const k = this.knobs.steps[entity];
    return k ? Math.max(k.floor || 0, Math.round(pct / k.step) * k.step) : pct;
  }
  outcome(domain, service, data, s) {
    const a = s.attributes;
    switch (`${domain}.${service}`) {
      case "light.turn_on": return ["on", { brightness: data.brightness_pct === undefined ? (a.brightness || 255) : Math.round((this.snapped(data.entity_id, data.brightness_pct) / 100) * 255) }];
      case "light.turn_off": return ["off", { brightness: null }];
      case "humidifier.set_mode": return [s.state, { mode: data.mode }];
      /* Some dehumidifiers drop into a mode of their own whenever their target changes, one their integration can't
         ask for by name: knobs.targetModes[entity] = that mode. */
      case "humidifier.set_humidity": return [s.state, { humidity: data.humidity, ...(this.knobs.targetModes[data.entity_id] ? { mode: this.knobs.targetModes[data.entity_id] } : {}) }];
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
    if (msg.type === "environment_control/activity") return this.activityPage(msg);
    this.fail(`Unknown command ${msg.type}`);
  }
  /* One zone's activity for one local day, newest first, in the shape the backend's command returns. A real HA takes seconds
     to read a day from the logbook and can refuse while it's busy or never answer, which the knobs stand in for. It is asked
     by zone, never by entity, so a frame can only read what a zone holds. */
  async activityPage(msg) {
    this.activityCalls.push(JSON.parse(JSON.stringify(msg)));
    if (Object.keys(msg).some((k) => !["type", "zone", "day"].includes(k))) this.fail("Activity is asked for by zone and day only");
    if (!this.config.zones.some((z) => z.id === msg.zone)) this.fail(`Zone ${msg.zone} not found`);
    if (typeof msg.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(msg.day)) this.fail("A day is YYYY-MM-DD");
    await new Promise((r) => setTimeout(r, this.knobs.activityMs));
    if (this.knobs.activity === "timeout") return new Promise(() => {});
    if (this.knobs.activity === "busy") { const e = new Error("Busy reading another request"); e.code = "busy"; throw e; }
    const [y, m, d] = msg.day.split("-").map(Number), from = new Date(y, m - 1, d).getTime(), now = Date.parse(this.activity.now);
    const to = Math.min(new Date(y, m - 1, d + 1).getTime(), now);
    /* A zone added since has no history of its own: it starts today. */
    const earliest = Date.parse(this.activity.earliest[msg.zone] || "") || new Date(now).setHours(0, 0, 0, 0);
    const entries = (this.activity.entries[msg.zone] || []).filter((e) => { const t = Date.parse(e.when); return t >= from && t < to && t >= earliest; })
      .sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
    const iso = (t) => new Date(t).toISOString();
    return JSON.parse(JSON.stringify({ zone: msg.zone, start: iso(Math.max(from, earliest)), end: iso(Math.max(to, from)), earliest: iso(earliest), more: from > earliest, next_end: iso(from), entries }));
  }
  /* The real backend checks every field against a schema. This checks enough to catch a host that forwards junk. */
  checkConfig(c, before) {
    /* A spot on a zone's map is on the half-steps, from outside the wall on one side to outside it on the other. */
    const spotOk = (p, L) => !!L && Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isInteger(x * 2)) && p[0] >= -1 && p[0] <= L.rows && p[1] >= -1 && p[1] <= L.cols;
    const ok = c && Array.isArray(c.zones) && Array.isArray(c.devices) && c.zones.length <= 20 && c.devices.length <= 200;
    if (!ok) this.fail("Config isn't zones and devices");
    /* A setup read back from storage carries its revision, which a save sets itself. Nothing else is a setup's to hold. */
    if (Object.keys(c).some((k) => !["zones", "devices", "room", "revision"].includes(k))) this.fail("Config holds something other than zones, devices and room settings");
    /* Settings for the whole room rather than one zone: so far only the helper every alert's repeat rate comes from. */
    if (c.room !== undefined) {
      const room = c.room, keys = room && typeof room === "object" && !Array.isArray(room) ? Object.keys(room) : null;
      if (!keys || keys.some((k) => k !== "alertRepeat")) this.fail("Room settings hold only the alert repeat rate");
      if (room.alertRepeat !== undefined && !(typeof room.alertRepeat === "string" && /^input_number\.[a-z0-9_]+$/.test(room.alertRepeat))) this.fail("The alert repeat rate links to something that isn't a number helper");
    }
    /* Automations a zone switches: an automation entity, a group, an id the frame names it by, and optionally a name of the
       panel's own, as long as a device's. Nothing else. One
       automation belongs to one zone, as the real backend has it. */
    const GROUPS = ["alert_day", "alert_night", "alert_device", "failsafe", "control"];
    const linked = new Set();
    for (const z of c.zones) {
      if (z.automations === undefined) continue;
      if (!Array.isArray(z.automations) || z.automations.length > 200) this.fail(`${z.id} links automations that aren't a short list`);
      const aids = new Set(), ents = new Set();
      for (const a of z.automations) {
        const keys = a && typeof a === "object" ? Object.keys(a).sort().join() : "";
        if (keys !== "entity,group,id" && keys !== "entity,group,id,name") this.fail(`${z.id} links an automation with something other than an id, an entity, a group and a name`);
        if (a.name !== undefined && !(typeof a.name === "string" && a.name.length <= 100 && a.name.trim() === a.name && /^[^\u0000-\u001f\u007f]+$/.test(a.name))) this.fail(`${z.id} gives an automation a name that isn't short text`);
        if (typeof a.id !== "string" || !/^[a-z0-9_-]{1,64}$/.test(a.id) || aids.has(a.id)) this.fail(`${z.id} has automation links without unique ids`);
        if (typeof a.entity !== "string" || !/^automation\.[a-z0-9_]+$/.test(a.entity) || ents.has(a.entity)) this.fail(`${z.id} links something that isn't an automation, or one twice`);
        if (!GROUPS.includes(a.group)) this.fail(`${z.id} puts an automation in a group this panel doesn't know`);
        if (linked.has(a.entity)) this.fail("An automation can only be linked to one zone.");
        aids.add(a.id); ents.add(a.entity);
      }
      for (const e of ents) linked.add(e);
    }
    const ids = new Set(c.zones.map((z) => z.id));
    if (ids.size !== c.zones.length || c.zones.some((z) => typeof z.id !== "string" || !/^[a-z0-9_]{1,40}$/.test(z.id))) this.fail("Zone ids must be unique slugs");
    for (const z of c.zones) this.checkZoneName(z);
    /* A linked zone shows what its parent runs, so a parent has to be a plain zone: one level, never itself. The reason
       is told from the side of the zone whose link just changed. */
    const moved = (z) => ((before?.zones || []).find((o) => o.id === z.id) || {}).parent !== z.parent;
    for (const z of [...c.zones].sort((a, b) => moved(b) - moved(a))) {
      if (z.parent === undefined) continue;
      const parent = c.zones.find((o) => o.id === z.parent);
      if (typeof z.parent !== "string" || !parent) this.fail(`${z.id} is linked to a zone that doesn't exist`);
      if (parent === z) this.fail(`${z.id} can't be linked to itself`);
      if (c.zones.some((o) => o.parent === z.id)) this.fail(`${z.id} has zones linked to it, so it can't be linked to another`);
      if (parent.parent !== undefined) this.fail(`${z.id} is linked to a zone that is itself linked to another`);
    }
    /* A sensor in two zones shows one zone's readings in another, which only a parent link may do: every zone a sensor is
       in is one family, a parent and the zones linked to it. Breaking a link a sensor is shared across names the sensor. */
    const holders = new Map(), held = new Map(), was = new Map((before?.zones || []).map((z) => [z.id, z.parent]));
    for (const z of before?.zones || []) for (const x of Array.isArray(z.sensors) ? z.sensors : []) if (x && typeof x.id === "string") held.set(x.id, new Set([...(held.get(x.id) || []), z.id]));
    for (const z of c.zones) for (const x of Array.isArray(z.sensors) ? z.sensors : []) if (x && typeof x.id === "string") holders.set(x.id, [...(holders.get(x.id) || []), { z, name: x.name || x.id }]);
    const root = (z) => z.parent || z.id, rootBefore = (id) => was.get(id) || id, named = (z) => z.name || z.id;
    for (const [sid, list] of holders) {
      if (new Set(list.map((h) => root(h.z))).size === 1) continue;
      /* A setup stored before this rule can hold a sensor in several unrelated zones, and the panel saves one zone at a
         time, so such a share is let through while it only shrinks: no zone joins it and no linked pair in it comes apart. */
      const had = held.get(sid) || new Set();
      if (list.every((h) => had.has(h.z.id)) && list.every((a) => list.every((b) => root(a.z) === root(b.z) || rootBefore(a.z.id) !== rootBefore(b.z.id)))) continue;
      /* A link this save leaves in place isn't being broken, so that pair isn't what the save got wrong. */
      for (const a of list) for (const b of list) {
        const [child, other] = was.get(a.z.id) === b.z.id ? [a.z, b.z] : [b.z, a.z];
        if (a !== b && was.get(child.id) === other.id && child.parent !== other.id) this.fail(`${a.name} is in both ${named(a.z)} and ${named(b.z)}. Take it out of ${named(child)} before unlinking it.`);
      }
      const zones = [...new Set(list.map((h) => h.z))].map(named);
      this.fail(`${list[0].name} is in Zone: ${zones.length === 1 ? zones[0] : `${zones.slice(0, -1).join(", ")} and ${zones.at(-1)}`}. A sensor can only be shared between a zone and the zones linked to it.`);
    }
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
        /* One added in Device identification has no spot until Device placement gives it one. */
        if (v.pos != null && !spotOk(v.pos, z.layout)) this.fail(`${v.id} is placed outside ${z.id}'s map`);
      }
    }
  }
  /* A zone's name goes into refusals, so it is held to a link's name: short text with no control characters. */
  checkZoneName(z) {
    if (z.name !== undefined && z.name !== null && !(typeof z.name === "string" && z.name.trim() && z.name.length <= 100 && /^[^\u0000-\u001f\u007f]+$/.test(z.name))) this.fail(`${z.id} has a name that isn't short text`);
  }
  /* Revision-checked, so a save made from a stale copy can't undo someone else's. */
  save(msg) {
    if (msg.revision !== this.config.revision) this.fail("Setup was saved from somewhere else since this was opened. Reopen the panel to see it.");
    if (!msg.config || typeof msg.config !== "object") this.checkConfig(msg.config);
    const next = { ...JSON.parse(JSON.stringify(msg.config)), revision: this.config.revision + 1 };
    /* Removing a parent zone unlinks the zones linked to it, which stay, unless one still has a sensor of the parent's. A
       parent no setup ever had is still refused. */
    const kept = new Set((Array.isArray(next.zones) ? next.zones : []).map((z) => z && z.id));
    const removed = (this.config.zones || []).filter((z) => !kept.has(z.id));
    for (const z of Array.isArray(next.zones) ? next.zones : []) {
      if (!z || typeof z.id !== "string" || !/^[a-z0-9_]{1,40}$/.test(z.id)) continue;
      const was = ((this.config.zones || []).find((o) => o.id === z.id) || {}).parent, gone = removed.find((p) => p.id === z.parent || p.id === was);
      if (!gone) continue;
      const shared = (gone.sensors || []).find((x) => (Array.isArray(z.sensors) ? z.sensors : []).some((y) => y && y.id === x.id));
      if (shared) {
        this.checkZoneName(z);
        const here = z.name || z.id, there = gone.name || gone.id;
        this.fail(`${shared.name || shared.id} is in both ${there} and ${here}. Take it out of ${here} before removing ${there}.`);
      }
      delete z.parent;
    }
    this.checkConfig(next, this.config);
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
