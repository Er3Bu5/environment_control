# Read-only: history and logbook GETs for the mock's snapshot. Keeps states and timestamps only.
import json, os, sys, datetime as dt, urllib.request, urllib.parse
base = os.environ["HA_URL"].rstrip("/")
headers = {"Authorization": "Bearer " + os.environ["HA_TOKEN"], "User-Agent": "agent-tools"}
def get(path, params):
    head, stamp = path.rsplit("/", 1)
    url = base + head + "/" + urllib.parse.quote(stamp) + "?" + urllib.parse.urlencode(params)
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=180))
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
iso = lambda t: t.isoformat()
env = [f"sensor.{b}_{m}" for b in ("garden_environment_left", "garden_environment_right", "veg_environment", "nursery_environment") for m in ("air_temp", "humidity", "vpd", "light")]
hist = get("/api/history/period/" + iso(now - dt.timedelta(hours=24)), {"filter_entity_id": ",".join(env), "end_time": iso(now), "no_attributes": "", "significant_changes_only": "0"})
out = {"now": iso(now), "history": {r[0]["entity_id"]: [[p.get("last_changed") or p.get("last_updated"), p["state"]] for p in r] for r in hist if r}}
nz = dt.timezone(dt.timedelta(hours=13))
f = dt.datetime(2026, 11, 2, 9, 50, tzinfo=nz); t = dt.datetime(2026, 11, 2, 10, 50, tzinfo=nz)
raw = [f"sensor.garden_soil_{i}_substrate_humidity" for i in (1, 2, 3)]
hist = get("/api/history/period/" + iso(f), {"filter_entity_id": ",".join(raw), "end_time": iso(t), "no_attributes": "", "significant_changes_only": "0"})
out["soil"] = {r[0]["entity_id"]: [[p.get("last_changed") or p.get("last_updated"), p["state"]] for p in r] for r in hist if r}
log = ["switch.air_conditioner", "switch.heater_mains", "switch.garden_intake_fan", "switch.air_conditioner_exhaust_fan", "switch.veg_oscillating_fans", "humidifier.garden_dehumidifier", "humidifier.auxiliary_dehumidifier", "fan.garden_dehumidifier", "switch.garden_lights_f_l", "switch.garden_lights_under_canopy", "switch.garden_lights_red", "switch.veg_lights"]
out["logbook"] = get("/api/logbook/" + iso(now - dt.timedelta(hours=14)), {"entity": ",".join(log), "end_time": iso(now)})
states = json.load(urllib.request.urlopen(urllib.request.Request(base + "/api/states", headers=headers), timeout=30))
out["lights"] = sorted(s["entity_id"] for s in states if s["entity_id"].startswith("light."))
out["pulse"] = [[s["entity_id"], s["state"], s["last_changed"]] for s in states if "veg_pulse" in s["entity_id"]]
json.dump(out, open(sys.argv[1], "w"))
print({k: len(v) for k, v in out["history"].items()}); print({k: len(v) for k, v in out["soil"].items()}); print("logbook", len(out["logbook"])); print(out["lights"]); print(out["pulse"][:6])
