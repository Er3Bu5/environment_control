# Read-only: as much history as HA holds, one entity per GET, bucketed here so raw rows never reach the mock.
import json, os, sys, time, datetime as dt, urllib.request, urllib.parse
base = os.environ["HA_URL"].rstrip("/")
headers = {"Authorization": "Bearer " + os.environ["HA_TOKEN"], "User-Agent": "agent-tools"}
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
start = now - dt.timedelta(days=31)
STEP = 900
parse = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
def get(entity):
    url = f"{base}/api/history/period/{urllib.parse.quote(start.isoformat())}?" + urllib.parse.urlencode({"filter_entity_id": entity, "end_time": now.isoformat(), "no_attributes": "", "minimal_response": "", "significant_changes_only": "0"})
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=300))
out = {"now": now.isoformat(), "step": STEP, "buckets": {}, "first": {}, "timing": {}}
n = int((now - start).total_seconds() // STEP) + 1
for b in ("garden_environment_left", "garden_environment_right", "veg_environment", "nursery_environment"):
    for m in ("air_temp", "humidity", "vpd", "light"):
        e = f"sensor.{b}_{m}"
        t0 = time.time(); rows = get(e); rows = rows[0] if rows else []
        took = time.time() - t0
        cells = [[] for _ in range(n)]
        points = []
        for r in rows:
            try: points.append((parse(r.get("last_changed") or r["last_updated"]), float(r["state"])))
            except ValueError: points.append((parse(r.get("last_changed") or r["last_updated"]), None))
        for when, v in points:
            back = int((now - when).total_seconds() // STEP)
            if 0 <= back < n and v is not None: cells[n - 1 - back].append(v)
        # An unchanged value writes no row with minimal_response, so a quiet bucket holds the last value unless it went dead.
        carry = {}; i = 0; seq = sorted(points)
        result = []
        for ix in range(n):
            edge = now - dt.timedelta(seconds=(n - 1 - ix) * STEP)
            while i < len(seq) and seq[i][0] <= edge: carry["v"] = seq[i][1]; i += 1
            c = cells[ix]
            result.append([round(sum(c) / len(c), 3), min(c), max(c)] if c else ([carry["v"]] * 3 if carry.get("v") is not None else None))
        out["buckets"][e] = result
        out["first"][e] = rows[0].get("last_changed") if rows else None
        out["timing"][e] = [len(rows), round(took, 1)]
        print(e, len(rows), f"{took:.1f}s", flush=True)
json.dump(out, open(sys.argv[1], "w"), separators=(",", ":"))
