"""A zone's limits and its day and night as they were over a range, for History's bands and Activity's judgements.

A limit on a helper has a past in Home Assistant's recorder. A limit stored here has none there, so every save that
changes one is logged by the store: when, which zone, what, and the source before and after. A source is
`{"entity": id}` for a limit read off a number helper, `{"value": n}` for one stored here (n is None for a zone that
aims for no target), or None where the zone has no such limit at all. The day and night source is logged the same way.

Each answer rebuilds every series from the source in force now, walked back through the log. Before the oldest moment
the log covers, the source in force at that moment is assumed; the answer's `known_from` says when that is, where it
falls inside the range and the assumption is a value stored here.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable
from datetime import datetime, time, timedelta, tzinfo
from typing import Any

from .const import MAX_LOOKBACK_HOURS

PERIODS = ("day", "night")
SLOTS = ("min", "low", "target", "high", "max")
# Low and High are always stored here; the rest can sit on a helper.
HELPER_SLOTS = frozenset({"min", "target", "max"})
BAND_METRICS = ("temperature", "humidity", "vpd")
# Light has one limit a period: a minimum by day and a maximum by night.
LIGHT_SLOTS = {"day": "min", "night": "max"}
LIGHT_KEYS = {"day": "dayMin", "night": "nightMax"}
PHOTOPERIOD = "photoperiod"

# The log is kept a day past History's longest range, so the oldest range drawn still starts inside it.
LOG_KEEP_HOURS = MAX_LOOKBACK_HOURS + 24
# A save that changes every limit of every zone logs about 660 entries; this holds a few of those even in a busy week.
MAX_LOG_ENTRIES = 2000
# A helper some automation moves every few minutes would otherwise send thousands of steps to a phone.
MAX_STEPS = 200

Source = dict[str, Any] | None
Rows = list[tuple[float, Any]]


def _number(v: Any) -> float | None:
    try:
        n = float(v)
    except TypeError, ValueError:
        return None
    return n if math.isfinite(n) else None


def _dig(v: Any, *keys: str) -> Any:
    for k in keys:
        v = v.get(k) if isinstance(v, dict) else None
    return v


def limit_source(zone: dict[str, Any], period: str, metric: str, slot: str) -> Source:
    """Where one limit of a zone comes from now."""
    if metric == "light":
        if LIGHT_SLOTS.get(period) != slot:
            return None
        entity = _dig(zone, "helpers", "light", period)
        if isinstance(entity, str):
            return {"entity": entity}
        light = zone.get("lightLimits")
        value = light.get(LIGHT_KEYS[period]) if isinstance(light, dict) else None
        return {"value": value} if value is not None else None
    values = _dig(zone, "bands", period, metric)
    if metric not in BAND_METRICS or not isinstance(values, list) or len(values) != len(SLOTS):
        return None
    value = values[SLOTS.index(slot)]
    entity = _dig(zone, "helpers", "bands", period, metric, slot)
    # A zone with no target no longer reads its target helper, so that link is ignored with it.
    if slot in HELPER_SLOTS and isinstance(entity, str) and not (slot == "target" and value is None):
        return {"entity": entity}
    return {"value": value}


def period_source(zone: dict[str, Any]) -> dict[str, Any]:
    """Where a zone's day and night come from now, by the frame's own reading of a setup."""
    helpers = zone.get("helpers") if isinstance(zone.get("helpers"), dict) else {}
    mode = zone.get("periodMode")
    if mode not in ("helper", "fixed", "detected"):
        mode = "helper" if helpers.get("day") and helpers.get("night") else "fixed"
    if mode == "helper":
        return {"mode": mode, "day": helpers.get("day"), "night": helpers.get("night")}
    if mode == "detected":
        lights = [e for e in zone.get("lights") or [] if isinstance(e, str)]
        return {"mode": mode, "lights": lights, "rule": "all" if zone.get("rule") == "all" else "any"}
    return {"mode": mode, "day": zone.get("dayAt", 0), "night": zone.get("nightAt", 0)}


def zone_sources(zone: dict[str, Any]) -> dict[str, Source]:
    """Every source the log watches in one zone, by name: `day.temperature.max`, ..., and `photoperiod`."""
    out: dict[str, Source] = {
        f"{p}.{m}.{s}": limit_source(zone, p, m, s) for p in PERIODS for m in BAND_METRICS for s in SLOTS
    }
    out.update({f"{p}.light.{s}": limit_source(zone, p, "light", s) for p, s in LIGHT_SLOTS.items()})
    out[PHOTOPERIOD] = period_source(zone)
    return out


def _zones(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    zones = config.get("zones") if isinstance(config, dict) else None
    return {z["id"]: z for z in zones or [] if isinstance(z, dict) and isinstance(z.get("id"), str)}


def record_changes(
    log: dict[str, Any], before: dict[str, Any], after: dict[str, Any], now: float, started: float
) -> dict[str, Any]:
    """The log once a save from `before` to `after` is added, trimmed to its age and size.

    `since` holds, per zone, the moment from which the log has every change. A zone the log hasn't seen yet has had
    none since `started`, when this code began running: nothing else changes a stored limit.
    """
    old, new = _zones(before), _zones(after)
    since = {z: t for z, t in (log.get("since") or {}).items() if z in new}
    entries = [e for e in log.get("entries") or [] if e.get("zone") in new]
    for zid, zone in new.items():
        if zid not in old:
            since[zid] = now
            continue
        since.setdefault(zid, started)
        was = zone_sources(old[zid])
        entries.extend(
            {"t": now, "zone": zid, "what": what, "old": was[what], "new": src}
            for what, src in zone_sources(zone).items()
            if src != was[what]
        )
    cutoff = now - LOG_KEEP_HOURS * 3600
    drop = 0
    while drop < len(entries) and (entries[drop]["t"] < cutoff or len(entries) - drop > MAX_LOG_ENTRIES):
        e = entries[drop]
        # The dropped entry's new source is still known from the next one's old, so knowledge resumes at its time.
        since[e["zone"]] = max(since.get(e["zone"], e["t"]), e["t"])
        drop += 1
    return {"since": since, "entries": entries[drop:]}


def timeline(entries: list[dict[str, Any]], current: Any, start: float, end: float) -> list[tuple[float, Any]]:
    """Each (from, source) in force over [start, end), the first from start, walked back from `current`."""
    sources = [(-math.inf, entries[0]["old"] if entries else current)]
    sources += [(e["t"], e["new"]) for e in entries[:-1]]
    if entries:
        sources.append((entries[-1]["t"], current))
    out = [(start, sources[0][1])]
    for t, src in sources[1:]:
        if t <= start:
            out[0] = (start, src)
        elif t < end:
            out.append((t, src))
    return out


def _in_force(rows: Rows, at: float) -> Any:
    """The last number a helper held at `at`: a state that isn't one leaves the one before it in force."""
    held = None
    for t, state in rows:
        if t > at:
            break
        v = _number(state)
        held = held if v is None else v
    return held


def merge(steps: Iterable[list[Any]]) -> list[list[Any]]:
    """Steps with each repeat of the value before it left out, and at most MAX_STEPS.

    Past the cap the oldest changes go, so the recent end, where readings are judged most, stays exact; the first
    pair then carries the value in force just before the first change kept.
    """
    out: list[list[Any]] = []
    for t, v in steps:
        if out and out[-1][1] == v:
            continue
        if out and t <= out[-1][0]:
            out[-1][1] = v
            if len(out) > 1 and out[-2][1] == v:
                out.pop()
            continue
        out.append([t, v])
    if len(out) > MAX_STEPS:
        out = [[out[0][0], out[-MAX_STEPS][1]], *out[-MAX_STEPS + 1 :]]
    return out


def limit_steps(segments: list[tuple[float, Any]], end: float, read: Callable[[str], Rows]) -> list[list[Any]]:
    """One limit's steps over the range from its sources: a stored value holds; a helper steps with its records."""
    steps: list[list[Any]] = []
    for i, (a, src) in enumerate(segments):
        b = segments[i + 1][0] if i + 1 < len(segments) else end
        if not isinstance(src, dict) or "entity" not in src:
            steps.append([a, _number(src.get("value")) if isinstance(src, dict) else None])
            continue
        rows = read(src["entity"])
        steps.append([a, _in_force(rows, a)])
        held = steps[-1][1]
        for t, state in rows:
            v = _number(state)
            if a < t < b and v is not None and v != held:
                steps.append([t, v])
                held = v
    return merge(steps)


TIME = re.compile(r"(\d\d):(\d\d)")


def minutes(state: Any) -> int | None:
    """A time helper's state as minutes into the day, read the frame's way: its leading hours and minutes."""
    m = TIME.match(state) if isinstance(state, str) else None
    return int(m[1]) * 60 + int(m[2]) if m and int(m[1]) < 24 and int(m[2]) < 60 else None


def is_day(day_at: int, night_at: int, minute: int) -> bool:
    """Wrap-safe: a photoperiod that crosses midnight has its night inside the day's numbers rather than around them."""
    t = minute % 1440
    return day_at <= t < night_at if day_at < night_at else t >= day_at or t < night_at


def _minute_of(ts: float, tz: tzinfo) -> int:
    local = datetime.fromtimestamp(ts, tz)
    return local.hour * 60 + local.minute


def clock_periods(schedule: list[tuple[float, int, int]], start: float, end: float, tz: tzinfo) -> list[list[Any]]:
    """Day and night over [start, end) from lights on and off times, local to `tz`, which may change on the way.

    `schedule` is each (from, day_at, night_at) in time order, the first in force at start.
    """
    out: list[list[Any]] = []
    for i, (t, day_at, night_at) in enumerate(schedule):
        a = max(t, start)
        b = min(schedule[i + 1][0], end) if i + 1 < len(schedule) else end
        if b <= a and out:
            continue
        out.append([a, "day" if is_day(day_at, night_at, _minute_of(a, tz)) else "night"])
        first = datetime.fromtimestamp(a, tz).date() - timedelta(days=1)
        moments = []
        for d in range((datetime.fromtimestamp(b, tz).date() - first).days + 1):
            date = first + timedelta(days=d)
            for m in (day_at, night_at):
                ts = datetime.combine(date, time(m // 60, m % 60), tz).timestamp()
                if a < ts < b:
                    moments.append(ts)
        out.extend([ts, "day" if is_day(day_at, night_at, _minute_of(ts, tz)) else "night"] for ts in sorted(moments))
    return out


def _times(rows_day: Rows, rows_night: Rows, fallback: tuple[int, int]) -> list[tuple[float, int, int]]:
    """Lights on and off as they stepped on their helpers; a state that isn't a time leaves the one before it."""
    events = sorted([(t, 0, s) for t, s in rows_day] + [(t, 1, s) for t, s in rows_night], key=lambda e: e[0])
    held = list(fallback)
    out: list[tuple[float, int, int]] = []
    for t, which, state in events:
        m = minutes(state)
        if m is not None:
            held[which] = m
        if out and out[-1][0] == t:
            out[-1] = (t, held[0], held[1])
        elif not out or out[-1][1:] != tuple(held):
            out.append((t, held[0], held[1]))
    return out


def detected_periods(lights: dict[str, Rows], rule: str, a: float, b: float) -> list[list[Any]]:
    """Day while any (or all) of the switches is on; None while none of them reports on or off."""
    events = sorted((t, e, s) for e, rows in lights.items() for t, s in rows)
    states: dict[str, Any] = {}

    def now() -> str | None:
        known = [s for s in states.values() if s in ("on", "off")]
        if not known:
            return None
        on = all(s == "on" for s in known) if rule == "all" else any(s == "on" for s in known)
        return "day" if on else "night"

    out: list[list[Any]] = []
    for t, entity, state in events:
        if t > a:
            if t >= b:
                break
            if not out:
                out.append([a, now()])
            states[entity] = state
            out.append([t, now()])
        else:
            states[entity] = state
    return out or [[a, now()]]


def period_steps(
    segments: list[tuple[float, Any]], end: float, read: Callable[[str], Rows], tz: tzinfo, fallback: tuple[int, int]
) -> list[list[Any]]:
    """Day and night over the range from each day and night source in force on the way."""
    steps: list[list[Any]] = []
    for i, (a, src) in enumerate(segments):
        b = segments[i + 1][0] if i + 1 < len(segments) else end
        mode = src.get("mode") if isinstance(src, dict) else None
        if mode == "detected":
            steps += detected_periods({e: read(e) for e in src["lights"]}, src["rule"], a, b)
            continue
        if mode == "helper":
            rows = [read(src[k]) if isinstance(src.get(k), str) else [] for k in ("day", "night")]
            times = _times(rows[0], rows[1], fallback)
            at_a = [x for x in times if x[0] <= a]
            schedule = [(a, *(at_a[-1][1:] if at_a else fallback))] + [x for x in times if x[0] > a]
        else:
            day_at, night_at = (src.get(k) if isinstance(src, dict) else None for k in ("day", "night"))
            schedule = [(a, day_at if isinstance(day_at, int) else 0, night_at if isinstance(night_at, int) else 0)]
        steps += clock_periods(schedule, a, b, tz)
    return merge(steps)


def zone_limits(
    zone: dict[str, Any],
    metric: str,
    entries: list[dict[str, Any]],
    since: float,
    tz: tzinfo,
    read: Callable[[str], Rows],
    start: float,
    end: float,
) -> dict[str, Any]:
    """The answer's `limits` for one zone and metric. Runs in the recorder's executor: `read` reads the recorder."""
    by_what: dict[str, list[dict[str, Any]]] = {}
    for e in entries:
        by_what.setdefault(e["what"], []).append(e)
    known_from = since if start < since else None
    assumed_stored = False

    def series(what: str, current: Any, steps: Callable[[list[tuple[float, Any]]], list[list[Any]]]) -> list:
        nonlocal assumed_stored
        segments = timeline(by_what.get(what, []), current, start, end)
        if known_from is not None:
            first = segments[0][1]
            stored = isinstance(first, dict) and ("value" in first or first.get("mode") == "fixed")
            assumed_stored = assumed_stored or stored
        return steps(segments)

    def limit(p: str, s: str) -> list:
        if metric not in (*BAND_METRICS, "light"):
            return [[start, None]]
        return series(f"{p}.{metric}.{s}", limit_source(zone, p, metric, s), lambda g: limit_steps(g, end, read))

    out: dict[str, Any] = {p: {s: limit(p, s) for s in SLOTS} for p in PERIODS}
    fallback = tuple(zone.get(k) if isinstance(zone.get(k), int) else 0 for k in ("dayAt", "nightAt"))
    out["period"] = series(PHOTOPERIOD, period_source(zone), lambda g: period_steps(g, end, read, tz, fallback))
    out["known_from"] = min(known_from, end) if assumed_stored and known_from is not None else None
    return out
