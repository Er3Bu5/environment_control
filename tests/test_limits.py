"""Limits and day and night as they were: the change log the store keeps, and the series rebuilt from it."""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from custom_components.environment_control.limits import (
    LOG_KEEP_HOURS,
    MAX_LOG_ENTRIES,
    MAX_STEPS,
    clock_periods,
    is_day,
    merge,
    record_changes,
    zone_limits,
)

H = 3600
DAY0 = datetime(2026, 11, 2, tzinfo=UTC).timestamp()  # a Monday, midnight UTC


def _zone(**over):
    z = {
        "id": "garden",
        "name": "Garden",
        "bands": {
            "day": {"temperature": [20, 22, 24, 26, 28], "humidity": [50, 55, 60, 65, 70], "vpd": [1, 1, 1, 1, 1]},
            "night": {"temperature": [16, 18, 20, 22, 24], "humidity": [50, 55, 60, 65, 70], "vpd": [1, 1, 1, 1, 1]},
        },
        "lightLimits": {"dayMin": 300, "nightMax": 5},
        "periodMode": "fixed",
        "dayAt": 6 * 60,
        "nightAt": 18 * 60,
    }
    z.update(over)
    return z


def _setup(*zones):
    return {"zones": list(zones), "devices": []}


def _with(z, period, metric, values):
    bands = {p: dict(v) for p, v in z["bands"].items()}
    bands[period][metric] = values
    return {**z, "bands": bands}


def _answer(zone, metric, log, start, end, since=None, rows=None, tz=UTC):
    entries = [e for e in log["entries"] if e["zone"] == zone["id"]]
    s = (log["since"] or {}).get(zone["id"], since)
    return zone_limits(zone, metric, entries, s, tz, lambda e: (rows or {}).get(e, []), start, end)


def test_lights_on_and_off_inside_the_range_for_a_day_schedule() -> None:
    steps = clock_periods([(DAY0, 360, 1080)], DAY0, DAY0 + 24 * H, UTC)
    assert steps == [[DAY0, "night"], [DAY0 + 6 * H, "day"], [DAY0 + 18 * H, "night"]]


def test_a_photoperiod_that_crosses_midnight_is_day_across_it() -> None:
    # Lights on at 16:00 and off at 10:00: day through midnight, night only from 10:00 to 16:00.
    assert is_day(960, 600, 23 * 60) and is_day(960, 600, 60) and not is_day(960, 600, 12 * 60)
    steps = clock_periods([(DAY0, 960, 600)], DAY0, DAY0 + 24 * H, UTC)
    assert steps == [[DAY0, "day"], [DAY0 + 10 * H, "night"], [DAY0 + 16 * H, "day"]]


def test_the_times_are_local_to_home_assistant() -> None:
    # Auckland is 13 hours ahead in November: the range opens at 13:00 there, lights off at 18:00 is 05:00 UTC and
    # lights on at 06:00 is 17:00 UTC.
    tz = ZoneInfo("Pacific/Auckland")
    steps = clock_periods([(DAY0, 360, 1080)], DAY0, DAY0 + 24 * H, tz)
    assert steps == [[DAY0, "day"], [DAY0 + 5 * H, "night"], [DAY0 + 17 * H, "day"]]


def test_a_time_changed_in_the_middle_of_the_range_moves_the_switches_after_it() -> None:
    # Lights off moved from 18:00 to 20:00 at noon, then the next morning lights on moved to 04:00 at 01:00.
    schedule = [(DAY0, 360, 1080), (DAY0 + 12 * H, 360, 1200), (DAY0 + 25 * H, 240, 1200)]
    steps = clock_periods(schedule, DAY0, DAY0 + 30 * H, UTC)
    assert merge(steps) == [
        [DAY0, "night"],
        [DAY0 + 6 * H, "day"],
        [DAY0 + 20 * H, "night"],
        [DAY0 + 28 * H, "day"],
    ]


def test_fixed_times_changed_by_a_save_step_the_period_and_are_known_from_the_log() -> None:
    start, end = DAY0, DAY0 + 24 * H
    before = _zone()
    after = _zone(nightAt=20 * 60)
    log = record_changes({}, _setup(before), _setup(after), DAY0 + 12 * H, started=DAY0 - 100 * H)
    ans = _answer(after, "temperature", log, start, end)
    assert ans["period"] == [[start, "night"], [start + 6 * H, "day"], [start + 20 * H, "night"]]
    assert ans["known_from"] is None


def test_two_saves_step_a_stored_limit_and_known_from_is_when_the_log_began() -> None:
    start, end = DAY0, DAY0 + 24 * H
    z0 = _zone()
    z1 = _with(z0, "day", "temperature", [20, 22, 24, 26, 29])
    z2 = _with(z0, "day", "temperature", [20, 22, 24, 26, 30])
    # This code started 4 hours into the range, so before that nothing stored here is known.
    log = record_changes({}, _setup(z0), _setup(z1), start + 8 * H, started=start + 4 * H)
    log = record_changes(log, _setup(z1), _setup(z2), start + 16 * H, started=start + 4 * H)
    ans = _answer(z2, "temperature", log, start, end)
    assert ans["day"]["max"] == [[start, 28], [start + 8 * H, 29], [start + 16 * H, 30]]
    assert ans["day"]["high"] == [[start, 26]]
    assert ans["known_from"] == start + 4 * H


def test_with_no_log_the_current_value_holds_and_known_from_is_when_this_code_started() -> None:
    start, end = DAY0, DAY0 + 24 * H
    ans = _answer(_zone(), "temperature", {"since": {}, "entries": []}, start, end, since=end)
    assert ans["day"]["max"] == [[start, 28]]
    # The range's end: every stored value is assumed for the whole range.
    assert ans["known_from"] == end


def test_a_limit_moved_from_stored_to_a_helper_is_stitched_at_the_save() -> None:
    start, end = DAY0, DAY0 + 24 * H
    z0 = _zone()
    z1 = {**z0, "helpers": {"bands": {"day": {"temperature": {"max": "input_number.day_max"}}}}}
    log = record_changes({}, _setup(z0), _setup(z1), start + 10 * H, started=start - H)
    rows = {"input_number.day_max": [(start, "31"), (start + 12 * H, "unavailable"), (start + 14 * H, "32")]}
    ans = _answer(z1, "temperature", log, start, end, rows=rows)
    assert ans["day"]["max"] == [[start, 28], [start + 10 * H, 31.0], [start + 14 * H, 32.0]]
    assert ans["known_from"] is None


def test_a_target_removed_then_set_again_is_null_between() -> None:
    start, end = DAY0, DAY0 + 24 * H
    z0 = _zone()
    z1 = _with(z0, "night", "temperature", [16, 18, None, 22, 24])
    z2 = _with(z0, "night", "temperature", [16, 18, 21, 22, 24])
    log = record_changes({}, _setup(z0), _setup(z1), start + 5 * H, started=start - H)
    log = record_changes(log, _setup(z1), _setup(z2), start + 9 * H, started=start - H)
    ans = _answer(z2, "temperature", log, start, end)
    assert ans["night"]["target"] == [[start, 20], [start + 5 * H, None], [start + 9 * H, 21]]


def test_light_has_only_a_day_minimum_and_a_night_maximum() -> None:
    start, end = DAY0, DAY0 + H
    ans = _answer(_zone(), "light", {"since": {"garden": start - H}, "entries": []}, start, end)
    assert ans["day"]["min"] == [[start, 300]] and ans["night"]["max"] == [[start, 5]]
    others = [ans[p][s] for p in ("day", "night") for s in ("min", "low", "target", "high", "max")]
    assert sum(x == [[start, None]] for x in others) == 8


def test_a_metric_with_no_limits_is_all_null_series() -> None:
    start, end = DAY0, DAY0 + H
    zone = {k: v for k, v in _zone().items() if k not in ("bands", "lightLimits")}
    for metric in ("temperature", "moisture"):
        ans = _answer(zone, metric, {"since": {}, "entries": []}, start, end, since=end)
        assert all(ans[p][s] == [[start, None]] for p in ("day", "night") for s in ans["day"])


def test_removing_a_zone_drops_its_log() -> None:
    a, b = _zone(), _zone(id="veg", name="Veg")
    log = record_changes({}, _setup(a, b), _setup(_with(a, "day", "vpd", [1, 1, 1, 1, 2]), b), DAY0, started=0)
    log = record_changes(log, _setup(a, b), _setup(_with(a, "day", "vpd", [1, 1, 1, 1, 2]), b), DAY0, started=0)
    assert {e["zone"] for e in log["entries"]} == {"garden"}
    b2 = _with(b, "day", "vpd", [1, 1, 1, 1, 3])
    log = record_changes(log, _setup(a, b), _setup(a, b2), DAY0 + 1, started=0)
    assert {e["zone"] for e in log["entries"]} == {"garden", "veg"}
    log = record_changes(log, _setup(a, b2), _setup(b2), DAY0 + 2, started=0)
    assert {e["zone"] for e in log["entries"]} == {"veg"} and set(log["since"]) == {"veg"}


def test_the_log_is_trimmed_to_its_age_and_capped_oldest_first() -> None:
    a = _zone()
    old = record_changes({}, _setup(a), _setup(_with(a, "day", "vpd", [1, 1, 1, 1, 2])), DAY0, started=0)
    later = DAY0 + (LOG_KEEP_HOURS + 1) * H
    log = record_changes(old, _setup(a), _setup(_with(a, "night", "vpd", [1, 1, 1, 1, 2])), later, started=0)
    assert [e["what"] for e in log["entries"]] == ["day.vpd.max", "night.vpd.max"][1:]
    # What the dropped entry said is still known from its time on, so the log is known from there.
    assert log["since"]["garden"] == DAY0

    many = {"since": {"garden": 0}, "entries": [{"t": later + i, "zone": "garden", "what": "x", "old": None,
                                                  "new": None} for i in range(MAX_LOG_ENTRIES)]}  # fmt: skip
    log = record_changes(many, _setup(a), _setup(_with(a, "day", "vpd", [1, 1, 1, 1, 4])), later + 10**4, 0)
    assert len(log["entries"]) == MAX_LOG_ENTRIES
    assert log["entries"][0]["t"] == later + 1 and log["entries"][-1]["what"] == "day.vpd.max"
    assert log["since"]["garden"] == later


def test_a_helper_that_changed_hundreds_of_times_is_capped_at_its_latest_steps() -> None:
    start = DAY0
    steps = merge([start + i, float(i)] for i in range(1000))
    assert len(steps) == MAX_STEPS
    assert steps[0] == [start, 1000.0 - MAX_STEPS] and steps[-1] == [start + 999, 999.0]
