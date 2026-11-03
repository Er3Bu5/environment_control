# Builds the published mock: the tested source with its fixture swapped for what Home Assistant reported.
# Bands: Min, Target and Max are the user's HA helpers. HA has no Low or High, so day Low and High come from the
# Athena stage assumed for each zone, held inside Min and Max, and night ones are midpoints.
import datetime as dt, json, os, re, statistics, sys

root = sys.argv[1]
S = json.load(open(f"{root}/ha-snap/states.json"))
H = json.load(open(f"{root}/ha-snap/history.json"))
LONG = json.load(open(f"{root}/ha-snap/history-long.json"))
NZ = dt.timezone(dt.timedelta(hours=13))
num = lambda e: float(S[e]["state"])
parse = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
now = parse(H["now"])
# When the states were read, not when this ran: a rebuild must not relabel old readings as new.
local = dt.datetime.fromtimestamp(os.path.getmtime(f"{sys.argv[1]}/ha-snap/states.json"), NZ)
NOW = local.hour * 60 + local.minute

ATHENA = {"veg": {"temperature": [22.2, 27.7], "humidity": [58, 75], "vpd": [0.8, 1.0]},
          "bulk": {"temperature": [23.8, 26.6], "humidity": [60, 70], "vpd": [1.0, 1.2]}}
METRICS = {"temperature": ("temperature", "air_temp"), "humidity": ("humidity", "humidity"), "vpd": ("vpd", "vpd")}
LABEL = {"temperature": ("Temperature", "°", 1), "humidity": ("Humidity", "%", 1), "vpd": ("VPD", " kPa", 2)}
r2 = lambda x: round(x + 1e-9, 2)

def band(zone, period, metric, stage):
    name = {"temperature": "temperature", "humidity": "humidity", "vpd": "vpd"}[metric]
    mn = num(f"input_number.{zone}_{period}_{name}_min_threshold")
    mx = num(f"input_number.{zone}_{period}_{name}_max_threshold")
    tkey = f"input_number.{zone}_{period}_{name}_target"
    tg = num(tkey) if tkey in S else None
    if period == "day":
        lo, hi = [min(mx, max(mn, x)) for x in ATHENA[stage][metric]]
        tg = r2((lo + hi) / 2) if tg is None else tg
    else:
        tg = r2((mn + mx) / 2) if tg is None else tg
        lo, hi = r2((mn + tg) / 2), r2((tg + mx) / 2)
    return [mn, r2(lo), tg, r2(hi), mx]

def bands(zone, stage):
    return {p: {m: band(zone, p, m, stage) for m in METRICS} for p in ("day", "night")}

def buckets(entity):
    out = [[] for _ in range(289)]
    for stamp, value in H["history"].get(entity, []):
        try:
            v = float(value)
        except ValueError:
            continue
        back = int((now - parse(stamp)).total_seconds() // 300)
        if 0 <= back <= 288:
            out[288 - back].append(v)
    return [[statistics.fmean(x), min(x), max(x)] if x else None for x in out]

DP = {"temperature": 2, "humidity": 1, "vpd": 3, "light": 0}
ENTITY = {"temperature": "air_temp", "humidity": "humidity", "vpd": "vpd", "light": "light"}
# Light is whole lux and JSON needs no .0, so it stays small.
tidy = lambda m, v: None if v is None else (round(v, DP[m]) if DP[m] else round(v))
def shaped(cells):
    out = {m: [None if c is None else tidy(m, c[0]) for c in cells[m]] for m in cells}
    out["lo"] = {m: [None if c is None else tidy(m, c[1]) for c in cells[m]] for m in cells}
    out["hi"] = {m: [None if c is None else tidy(m, c[2]) for c in cells[m]] for m in cells}
    return out

HISTORY, HISTORY_LONG = {}, {}
# HA purges what it doesn't keep, so the long arrays start where the first sensor does.
kept = min(next(i for i, c in enumerate(b) if c) for b in LONG["buckets"].values())
def history(sid, slug):
    HISTORY[sid] = shaped({m: buckets(f"sensor.{slug}_{ENTITY[m]}") for m in DP})
    HISTORY_LONG[sid] = shaped({m: LONG["buckets"][f"sensor.{slug}_{ENTITY[m]}"][kept:] for m in DP})

toMin = lambda e: int(S[e]["state"][:2]) * 60 + int(S[e]["state"][3:5])
limits = lambda z: {"dayMin": num(f"input_number.day_lights_{z}_min_threshold"), "nightMax": num(f"input_number.night_lights_{z}_max_threshold")}
def env(sid, name, short, slug, pos, level):
    history(sid, slug)
    return {"id": sid, "name": name, "short": short, "slug": slug, "kind": "env", "pos": pos, "level": level,
            "t": round(num(f"sensor.{slug}_air_temp"), 2), "h": round(num(f"sensor.{slug}_humidity"), 2),
            "vpd": round(num(f"sensor.{slug}_vpd"), 3), "lux": round(num(f"sensor.{slug}_light"), 1), "link": "Ethernet",
            "leafEntity": f"number.{slug}_leaf_temperature_offset", "leafLive": num(f"number.{slug}_leaf_temperature_offset")}

zones = [
    {"id": "garden", "name": "Garden", "dayAt": toMin("input_datetime.garden_day_time"), "nightAt": toMin("input_datetime.garden_night_time"), "bands": bands("garden", "bulk"), "linked": True, "lightLimits": limits("garden"),
     "emerson": {"morning": num("input_number.emerson_effect_morning_extension"), "daylight": num("input_number.emerson_effect_daylight_time"), "evening": num("input_number.emerson_effect_evening_extension")},
     "layout": {"w": 2.4, "d": 1.2, "units": 12, "rows": 3, "cols": 4},
     "sensors": [env("g-left", "Environment left", "Env left", "garden_environment_left", [0.5, 0], "in"),
                 env("g-right", "Environment right", "Env right", "garden_environment_right", [0.5, 3], "above")]},
    {"id": "veg", "name": "Veg", "dayAt": toMin("input_datetime.veg_day_time"), "nightAt": toMin("input_datetime.veg_night_time"), "bands": bands("veg", "veg"), "linked": True, "lightLimits": limits("veg"),
     "layout": {"w": 1.2, "d": 1.2, "units": 4, "rows": 2, "cols": 2},
     "sensors": [env("v-env", "Veg environment", "Veg env", "veg_environment", [0.5, 0.5], "above")]},
    {"id": "nursery", "name": "Nursery", "dayAt": toMin("input_datetime.veg_day_time"), "nightAt": toMin("input_datetime.veg_night_time"), "bands": bands("nursery", "veg"), "linked": True, "lightLimits": limits("nursery"),
     "layout": {"w": 1.2, "d": 0.6, "units": 8, "rows": 2, "cols": 4},
     "sensors": [env("n-env", "Nursery environment", "Nursery env", "nursery_environment", [0.5, 1.5], "in")]},
]
# The helpers each zone links to, only where HA has them: Veg and Nursery have no target helpers.
def links(zone, sched, emerson):
    have = lambda e: e if e in S else None
    bands = {p: {m: {k: e for k, e in (("min", have(f"input_number.{zone}_{p}_{m}_min_threshold")), ("target", have(f"input_number.{zone}_{p}_{m}_target")),
                                        ("max", have(f"input_number.{zone}_{p}_{m}_max_threshold"))) if e} for m in METRICS} for p in ("day", "night")}
    out = {"day": f"input_datetime.{sched}_day_time", "night": f"input_datetime.{sched}_night_time", "bands": bands,
           "light": {"dayMin": f"input_number.day_lights_{zone}_min_threshold", "nightMax": f"input_number.night_lights_{zone}_max_threshold"}}
    if emerson:
        out.update(morning="input_number.emerson_effect_morning_extension", daylight="input_number.emerson_effect_daylight_time", evening="input_number.emerson_effect_evening_extension")
    return out
for z, sched in zip(zones, ("garden", "veg", "veg")):
    z["helpers"] = links(z["id"], sched, z["id"] == "garden")
for z in zones:
    e = [s for s in z["sensors"] if s["kind"] == "env"]
    z["now"] = {"temperature": statistics.fmean(s["t"] for s in e), "humidity": statistics.fmean(s["h"] for s in e),
                "vpd": statistics.fmean(s["vpd"] for s in e), "light": statistics.fmean(s["lux"] for s in e)}

def is_day(z, minute):
    d, n = z["dayAt"], z["nightAt"]
    return d <= minute < n if d < n else minute >= d or minute < n
word = lambda e: "On" if S[e]["state"] == "on" else "Off"

# Devices: what the panel's backend would store, with what HA reports for each entity going to the fake HA's states.
tuya = {"integration": "tuya_local", "family": "Tuya", "link": "wifi", "source": "detected", "path": "Local", "hub": ""}
esphome = {"integration": "esphome", "family": "ESPHome", "link": "ethernet", "source": "confirmed", "path": "Local", "hub": ""}
d1, aux = "humidifier.garden_dehumidifier", "humidifier.auxiliary_dehumidifier"
ctl = lambda i, name, typ, ic, kind, entity, zs, base=tuya, **more: {"id": i, "name": name, "type": typ, "icon": ic, "ctl": kind, **base, "zones": zs, "entity": entity, **more}
sw = lambda i, name, typ, ic, entity, zs: ctl(i, name, typ, ic, "switch", entity, zs)
dimmer = lambda i, name, entity, zs: ctl(i, name, "Light", "sun", "dimmer", entity, zs, esphome)
plug = lambda i, name, entity, zs: sw(i, name, "Light", "sun", entity, zs)
board = lambda i, name, zs: {"id": i, "name": name, "type": "Sensor board", **esphome, "zones": zs, "state": "Online"}
devices = [
    ctl("dehu", "Dehumidifier", "Dehumidifier", "drop", "humidifier", d1, ["garden"]),
    ctl("aux", "Auxiliary dehumidifier", "Dehumidifier", "drop", "humidifier", aux, ["garden", "veg", "nursery"], note="Unit sensor, not room RH"),
    sw("ac", "Air conditioner", "Air conditioner", "gauge", "switch.air_conditioner", ["garden"]),
    sw("heater", "Heater", "Heater", "thermo", "switch.heater_mains", ["garden", "veg", "nursery"]),
    sw("intake", "Intake fan", "Fan", "fan", "switch.garden_intake_fan", ["garden"]),
    sw("acfan", "Air conditioner exhaust fan", "Fan", "fan", "switch.air_conditioner_exhaust_fan", ["garden"]),
    sw("fans", "Oscillating fans", "Fan", "fan", "switch.veg_oscillating_fans", ["veg", "nursery"]),
    dimmer("lc-over", "Garden Light Controller", "light.garden_light_controller_overhead", ["garden"]),
    plug("lp-fl", "Garden Lights F/L", "switch.garden_lights_f_l", ["garden"]), plug("lp-fr", "Garden Lights F/R", "switch.garden_lights_f_r", ["garden"]),
    plug("lp-bl", "Garden Lights B/L", "switch.garden_lights_b_l", ["garden"]), plug("lp-br", "Garden Lights B/R", "switch.garden_lights_b_r", ["garden"]),
    plug("lp-red", "Red Lights", "switch.garden_lights_red", ["garden"]),
    dimmer("lc-under", "Garden UC Light Controller", "light.garden_light_controller_under_canopy", ["garden"]),
    plug("lp-under", "Garden Lights Under Canopy", "switch.garden_lights_under_canopy", ["garden"]),
    dimmer("lc-veg", "Veg Light Controller", "light.veg_light_controller", ["veg", "nursery"]),
    plug("lp-veg", "Veg Lights", "switch.veg_lights", ["veg", "nursery"]),
    board("b-left", "Garden Environment Left", ["garden"]), board("b-right", "Garden Environment Right", ["garden"]),
    board("b-veg", "Veg Environment", ["veg"]), board("b-nursery", "Nursery Environment", ["nursery"]),
    {"id": "pulse", "name": "Pulse Pro", "type": "Sensor", "integration": "pulselabs", "family": "Pulse", "link": "wifi", "source": "detected", "path": "Cloud", "hub": "", "zones": ["veg"], "state": "Online"},
    {"id": "vpd", "name": "Garden environment average VPD", "type": "Calculated", "integration": "template", "family": "Template", "link": "derived", "source": "detected", "path": "Local", "hub": "", "zones": ["garden"], "state": "Online"},
]
def ha_state(entity):
    if entity not in S:
        sys.exit(f"{entity} is not in the snapshot")
    attrs = {"friendly_name": S[entity]["name"] or entity, **S[entity]["attrs"]}
    if entity.startswith("humidifier.") and "min_humidity" not in attrs:
        sys.exit("the snapshot predates humidifier limits: run ha-snap/states.py again")
    return {"state": S[entity]["state"], "attributes": attrs}
STATES = {d["entity"]: ha_state(d["entity"]) for d in devices if "entity" in d}
def flat(v):
    return [v] if isinstance(v, str) else [e for x in v.values() for e in flat(x)]
for z in zones:
    for e in flat(z["helpers"]):
        STATES[e] = {"state": S[e]["state"], "attributes": {"friendly_name": S[e]["name"] or e, **S[e]["attrs"], **({"has_date": False, "has_time": True} if e.startswith("input_datetime.") else {})}}
for z in zones:
    for x in z["sensors"]:
        e = x.get("leafEntity")
        if e:
            STATES[e] = {"state": S[e]["state"], "attributes": {"friendly_name": S[e]["name"] or e, **S[e]["attrs"], "unit_of_measurement": S[e]["unit"]}}
# What each failsafe holds a device to at the snapshot's time: the fans always on, the light plugs on their schedule.
def schedule(z):
    zone = next(x for x in zones if x["id"] == z)
    return "on" if is_day(zone, NOW) else "off"
FAILSAFES = {"switch.veg_oscillating_fans": {"want": "on", "kind": "failsafe", "by": "Veg fans auto on"},
             **{f"switch.garden_lights_{p}": {"want": schedule("garden"), "kind": "watchdog", "by": "Garden lights recovery"} for p in ("f_l", "f_r", "b_l", "b_r")},
             "switch.garden_lights_under_canopy": {"want": schedule("garden"), "kind": "watchdog", "by": "Garden lights under canopy recovery"},
             "switch.veg_lights": {"want": schedule("veg"), "kind": "watchdog", "by": "Veg lights recovery"}}

# Activity: the logbook, plus band crossings worked out from history, as the real panel would.
LOG = {"switch.air_conditioner": ("Air conditioner", "device", ["garden"]), "switch.heater_mains": ("Heater", "device", ["garden", "veg", "nursery"]),
       "switch.garden_intake_fan": ("Intake fan", "device", ["garden"]), "switch.air_conditioner_exhaust_fan": ("Air conditioner exhaust fan", "device", ["garden"]),
       "switch.veg_oscillating_fans": ("Oscillating fans", "device", ["veg", "nursery"]), d1: ("Dehumidifier", "device", ["garden"]), aux: ("Auxiliary dehumidifier", "device", ["garden", "veg", "nursery"]),
       "fan.garden_dehumidifier": ("Dehumidifier fan", "device", ["garden"]), "switch.garden_lights_f_l": ("Overhead lights", "lights", ["garden"]), "switch.garden_lights_under_canopy": ("Under canopy lights", "lights", ["garden"]),
       "switch.garden_lights_red": ("Red lights", "lights", ["garden"]), "switch.veg_lights": ("Veg lights", "lights", ["veg", "nursery"])}
rows = {z["id"]: [] for z in zones}
for e in H["logbook"]:
    known = LOG.get(e.get("entity_id"))
    if not known or e.get("state") not in ("on", "off"):
        continue
    name, kind, zs = known
    when = parse(e["when"]).astimezone(NZ)
    who = e.get("context_name") or ("Manual" if e.get("context_user_id") else "Device")
    for z in zs:
        rows[z].append((when, [f"{when:%H:%M}", kind, f"{name} turned {e['state']}", who]))

midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
for z in zones:
    e = [s for s in z["sensors"] if s["kind"] == "env"]
    for metric in METRICS:
        label, unit, dp = LABEL[metric]
        last = None
        for i in range(289):
            vals = [HISTORY[s["id"]][metric][i] for s in e if HISTORY[s["id"]][metric][i] is not None]
            if not vals:
                continue
            at = (now - dt.timedelta(minutes=(288 - i) * 5)).astimezone(NZ)
            v = statistics.fmean(vals)
            mn, lo, _, hi, mx = z["bands"]["day" if is_day(z, at.hour * 60 + at.minute) else "night"][metric]
            state = "critlow" if v < mn else "crithigh" if v > mx else "low" if v < lo else "high" if v > hi else "ok"
            if last is not None and state != last and at >= midnight:
                text = {"ok": "back in ideal zone", "low": "below ideal zone", "high": "above ideal zone", "critlow": "critical low", "crithigh": "critical high"}[state]
                rows[z["id"]].append((at, [f"{at:%H:%M}", "climate", f"{label} {text} at {v:.{dp}f}{unit}", "Reading"]))
            last = state

def recent(zone):
    device = [r for r in rows[zone] if r[1][1] != "climate"]
    climate = [r for r in rows[zone] if r[1][1] == "climate"][-8:]
    return [r[1] for r in sorted(device + climate, key=lambda r: r[0], reverse=True)]
ACTIVITY = {z["id"]: recent(z["id"]) for z in zones}

lights = {"garden": [[f"switch.garden_lights_{p}", f"Garden Lights {p.replace('_', '/').upper()}"] for p in ("f_l", "f_r", "b_l", "b_r")],
          "veg": [["switch.veg_lights", "Veg Lights"]], "nursery": [["switch.veg_lights", "Veg Lights"]]}
onoff = [[e, S[e]["name"] or e, word(e)] for e in ("light.garden_light_controller_overhead", "light.garden_light_controller_under_canopy", "light.veg_light_controller", "switch.garden_lights_under_canopy", "switch.garden_lights_red") if e in S]

js = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))
src = open(f"{root}/environment-control-source.html", encoding="utf-8").read()

def sub(pattern, replacement):
    global src
    src, n = re.subn(pattern, lambda _: replacement, src, count=1, flags=re.S)
    if n != 1:
        sys.exit(f"no match: {pattern[:50]}")

sub(r'const NOW = 14 \* 60 \+ 20;\nconst DATA_LABEL = .*?HISTORY_LONG = \{\};\n',
    f'const NOW = {NOW};\nconst DATA_LABEL = "HA snapshot", BASE_DATE = "{local:%Y-%m-%d}", HISTORY = {js(HISTORY)}, HISTORY_LONG = {js(HISTORY_LONG)};\n')
sub(r'const helperOptions = .*?;\n', 'const helperOptions = (z) => z.id === "garden" ? ["garden", "veg"] : ["veg", "garden"];\n')
sub(r'const ACTIVITY = \{.*?\n\};\n', f'const ACTIVITY = {js(ACTIVITY)};\n')
sub(r'const EXTRA_SENSORS = \[.*?\n\];\n', 'const EXTRA_SENSORS = [];\n')
sub(r'const LIGHTS = \{.*?\n\};\n', f'const LIGHTS = {js(lights)};\n')
sub(r'const ALL_ON_OFF = \[.*?\n\];\n', f'const ALL_ON_OFF = {js(onoff)};\n')
# Platforms are known from the device list, and areas are what HA reported for each entity.
AREAS = json.load(open(f"{root}/ha-snap/areas.json"))
area_id = lambda name: re.sub(r"[^a-z0-9]+", "_", name.lower()) if name else None
REGISTRY = {"entities": {d["entity"]: {"entity_id": d["entity"], "platform": d["integration"], "area_id": area_id(AREAS.get(d["entity"]))} for d in devices if "entity" in d},
            "areas": {area_id(n): {"area_id": area_id(n), "name": n} for n in set(AREAS.values()) if n}}
seed = {"config": {"revision": 1, "zones": zones, "devices": devices}, "states": STATES, "failsafes": FAILSAFES, "registry": REGISTRY}
if re.search(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|([0-9a-f]{2}:){5}[0-9a-f]{2}', json.dumps([zones, seed, ACTIVITY]), re.I):
    sys.exit("network identifier in the snapshot")
open(f"{root}/snapshot-ui.html", "w", encoding="utf-8").write(src)
open(f"{root}/snapshot-seed.js", "w", encoding="utf-8").write(f'"use strict";\n/* A real room, read from Home Assistant by build-snapshot.py. Not committed. */\nconst SEED = {js(seed)};\n')
import subprocess
subprocess.run([sys.executable, f"{root}/build-mock.py", root, "snapshot-ui.html", "snapshot-seed.js", "environment-control-mock.html"], check=True)

expect = {"zones": {
    "garden": {"temperature": num("sensor.garden_environment_average_temperature"), "humidity": num("sensor.garden_environment_average_humidity"), "vpd": num("sensor.garden_environment_average_vpd"),
               "light": zones[0]["now"]["light"]},
    "veg": {"temperature": num("sensor.veg_environment_air_temp"), "humidity": num("sensor.veg_environment_humidity"), "vpd": num("sensor.veg_environment_vpd"), "light": num("sensor.veg_environment_light")},
    "nursery": {"temperature": num("sensor.nursery_environment_air_temp"), "humidity": num("sensor.nursery_environment_humidity"), "vpd": num("sensor.nursery_environment_vpd"), "light": num("sensor.nursery_environment_light")}}}
clock = lambda e: S[e]["state"][:5]
level = S["light.garden_light_controller_overhead"]["attrs"].get("brightness")
expect["lights"] = {"overhead": None if S["light.garden_light_controller_overhead"]["state"] != "on" or level is None else round(level / 255 * 100)}
expect["sched"] = {z: {"day": clock(f"input_datetime.{h}_day_time"), "night": clock(f"input_datetime.{h}_night_time"), **limits(z)} for z, h in (("garden", "garden"), ("veg", "veg"), ("nursery", "veg"))}
e = zones[0]["emerson"]; on, off = zones[0]["dayAt"], zones[0]["nightAt"]
hm = lambda m: f"{int(m) // 60 % 24:02d}:{int(m) % 60:02d}"
expect["emerson"] = f"Red lights {hm(on - e['morning'])} - {hm(on + e['daylight'])} and {hm(off - e['daylight'])} - {hm(off + e['evening'])}"
json.dump(expect, open(f"{root}/ha-snap/expect.json", "w"))
print(f"built at {local:%H:%M}, {len(src) // 1024} KB")
for z in zones:
    print(z["id"], z["bands"]["day"], "|", z["bands"]["night"])
print({k: len(v) for k, v in ACTIVITY.items()})
