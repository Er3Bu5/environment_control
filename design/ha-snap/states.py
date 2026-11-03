# Read-only: GET /api/states, keeps the environment entities, drops network identifiers.
import json, os, re, sys, urllib.request
url = os.environ["HA_URL"].rstrip("/") + "/api/states"
headers = {"Authorization": "Bearer " + os.environ["HA_TOKEN"], "User-Agent": "agent-tools"}
states = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30))
keep = re.compile(r"^light\.|garden_environment|veg_environment|nursery_environment|dehumidifier|air_conditioner|heater|intake_fan|oscillating|veg_pulse|pulse|_threshold|_target|_day_time|_night_time|garden_lights|veg_lights|average|exhaust|emerson", re.I)
drop = re.compile(r"^(automation|script|update|button|device_tracker)\.|_ip$|mac|firmware|signal|uptime|version", re.I)
out = {s["entity_id"]: {"state": s["state"], "unit": s["attributes"].get("unit_of_measurement"), "name": s["attributes"].get("friendly_name"), "changed": s["last_changed"],
       "attrs": {k: v for k, v in s["attributes"].items() if k in ("mode", "available_modes", "humidity", "current_humidity", "min_humidity", "max_humidity", "min", "max", "step", "device_class", "brightness", "supported_color_modes")}}
       for s in states if keep.search(s["entity_id"]) and not drop.search(s["entity_id"])}
json.dump(out, open(sys.argv[1], "w"), indent=0)
print(len(states), "states,", len(out), "kept")
