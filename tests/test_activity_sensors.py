"""Activity's sensor rows: a zone's mapped readings that stopped reporting and came back, worked out from recorded
history by the panel's stale rule, merged by time with the logbook's rows and paged with them."""

import json
from datetime import timedelta

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.recorder.common import async_wait_recording_done

from custom_components.environment_control import activity
from custom_components.environment_control.activity import Reading, Turn
from custom_components.environment_control.const import DOMAIN
from custom_components.environment_control.history import STALE_S


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(recorder_mock, enable_custom_integrations):
    """The recorder has to start before HA does, so it comes ahead of the shared fixture here."""
    return


HEATER = "switch.garden_heater"
LEFT = {
    "temperature": "sensor.left_temp",
    "humidity": "sensor.left_rh",
    "vpd": "sensor.left_vpd",
    "light": "sensor.left_lux",
}
RIGHT, VEG = "sensor.right_temp", "sensor.veg_temp"
ROOM = {
    "zones": [
        {
            "id": "garden",
            "name": "Garden",
            "sensors": [
                {"id": "s1", "name": "Left", "kind": "env", "entities": LEFT},
                {"id": "s3", "name": "Right", "kind": "env", "entities": {"temperature": RIGHT}},
            ],
        },
        {
            "id": "veg",
            "name": "Veg",
            "sensors": [{"id": "s2", "name": "Veg", "kind": "env", "entities": {"temperature": VEG}}],
        },
    ],
    "devices": [{"id": "d1", "name": "Heater", "zones": ["garden"], "entity": HEATER}],
}
# Distinctive, so the answer can be searched for them.
VALUES = {"temperature": "23.456", "humidity": "61.789", "vpd": "1.2345", "light": "40321"}


@pytest.fixture
async def room(hass: HomeAssistant, hass_ws_client):
    assert await async_setup_component(hass, "logbook", {})
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/config/save", "revision": 0, "config": ROOM})
    assert (await client.receive_json())["success"]
    # Closed, since these tests move the clock on by many minutes: an open connection's heartbeat would lapse.
    await client.close()

    async def ask(**msg):
        return await _activity(await hass_ws_client(hass), **msg)

    return ask


async def _activity(client, **msg):
    await client.send_json_auto_id({"type": f"{DOMAIN}/activity", **msg})
    r = await client.receive_json()
    assert r["success"], r
    return r["result"]


class Clock:
    # Far less than half an hour in all, the life of the test's access token.
    def __init__(self, hass, freezer):
        self.hass, self.freezer = hass, freezer
        # Past the recorder's start: a reading's row from before it would read as current across a restart.
        self.now = dt_util.utcnow().replace(microsecond=0) + timedelta(seconds=1)

    async def at(self, seconds, *changes):
        """Move on, then make every change in the same instant."""
        self.now += timedelta(seconds=seconds)
        self.freezer.move_to(self.now)
        for entity, state in changes:
            self.hass.states.async_set(entity, state)
        await self.hass.async_block_till_done()
        return self.now.timestamp()


def _left(state=None, prefix=""):
    # HA records nothing for a state set again unchanged, so a reading that reports again reports something new.
    return [(e, state or prefix + VALUES[r]) for r, e in LEFT.items()]


def _rows(*pairs):
    # A row reported only when it changed: its last report is its own time.
    return [(t, state, t) for t, state in pairs]


def test_unavailable_then_back_is_a_stop_and_a_return() -> None:
    rows = _rows((0, "20"), (100, "20.5"), (150, "unavailable"), (400, "21"))
    assert activity.turns(rows, 1000) == [Turn(150, "stopped", 100), Turn(400, "back", 100)]
    assert activity.turns(_rows((0, "20"), (100, "unknown"), (110, "21")), 200) == [
        Turn(100, "stopped", 0),
        Turn(110, "back", 0),
    ]


def test_silence_past_the_stale_rule_is_a_stop_at_its_edge() -> None:
    rows = _rows((10, "20"), (20, "20"), (20 + STALE_S + 60, "21"))
    assert activity.turns(rows, 1200) == [Turn(20 + STALE_S, "stopped", 20), Turn(20 + STALE_S + 60, "back", 20)]
    # Still silent at the end of what was read.
    assert activity.turns(_rows((10, "20")), 10 + STALE_S + 1) == [Turn(10 + STALE_S, "stopped", 10)]


def test_a_shorter_silence_is_nothing() -> None:
    assert activity.turns(_rows((10, "20"), (10 + STALE_S, "21")), 10 + STALE_S + 1) == []
    assert activity.turns(_rows((10, "20")), 10 + STALE_S) == []


def test_four_readings_stopping_together_are_one_row_and_three_are_three() -> None:
    readings = [Reading("s1", "Left", r, e) for r, e in LEFT.items()]
    found = {e: [Turn(100 + i * 0.2, "stopped", 90), Turn(200, "back", 90)] for i, e in enumerate(LEFT.values())}
    rows = [x.row for x in activity.sensor_rows(readings, found, 0, 1000)]
    assert rows == [
        {"kind": "sensor", "when": 100, "sensor": "s1", "name": "Left", "reading": "all", "state": "stopped"},
        {"kind": "sensor", "when": 200, "sensor": "s1", "name": "Left", "reading": "all", "state": "back"},
    ]
    found["sensor.left_lux"] = []
    rows = [x.row for x in activity.sensor_rows(readings, found, 0, 1000)]
    assert [(r["reading"], r["state"]) for r in rows] == [
        ("temperature", "stopped"),
        ("humidity", "stopped"),
        ("vpd", "stopped"),
        ("temperature", "back"),
        ("humidity", "back"),
        ("vpd", "back"),
    ]
    # More than a second apart is not together.
    found = {e: [Turn(100 + i * 0.5, "stopped", 90)] for i, e in enumerate(LEFT.values())}
    assert [x.row["reading"] for x in activity.sensor_rows(readings, found, 0, 1000)] == list(LEFT)


def test_a_sensor_row_soon_after_a_start_is_put_down_to_it() -> None:
    readings = [Reading("s3", "Right", "temperature", RIGHT)]
    turns = [Turn(900, "stopped", 800), Turn(1100, "back", 800), Turn(1000 + activity.STARTUP_S + 1, "stopped", 1100)]
    rows = [x.row for x in activity.sensor_rows(readings, {RIGHT: turns}, 0, 2000, [1000])]
    assert [r.get("cause") for r in rows] == [None, {"type": "startup"}, None]


async def test_a_zone_page_with_sensor_rows_among_the_logbook(room, hass, freezer, monkeypatch) -> None:
    # Slices of a few seconds, so rows fall on their edges too.
    monkeypatch.setattr(activity, "SLICE_HOURS", 4 / 3600)
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (HEATER, "off"), (RIGHT, "19.5"), (VEG, "18.25"), *_left())
    t_on = await clock.at(1, (HEATER, "on"))
    t_gone = await clock.at(1, *_left("unavailable"))
    await clock.at(1, (VEG, "unavailable"))
    t_off = await clock.at(1, (HEATER, "off"))
    t_back = await clock.at(1, *_left())
    t_lux = await clock.at(1, ("sensor.left_lux", "unknown"))
    t_lux_back = await clock.at(1, ("sensor.left_lux", "40000"))
    # Left reports its values again unchanged, which records nothing but shows it reports while a value holds.
    t_heard = await clock.at(1, *_left()[:3], ("sensor.left_lux", "40000"))
    # Right keeps reporting; Left goes quiet past the stale rule, then reports again.
    for _ in range(3):
        await clock.at(STALE_S / 3 - 30, (RIGHT, str(clock.now.second)))
    t_quiet = await clock.at(STALE_S + 30 - 3 * (STALE_S / 3 - 30), *_left(prefix="1"))
    t_heat = await clock.at(1, (HEATER, "on"))
    await async_wait_recording_done(hass)

    result = await room(zone="garden", start=t0 - 60, end=t_heat + 1)
    assert result["more"] is False
    rows = [(e["kind"], e["when"], e.get("reading"), e.get("state"), e.get("since")) for e in result["entries"]]
    assert rows == [
        ("device", t_heat, None, "on", None),
        # Silent from their last report, not their last change, and back together.
        ("sensor", t_quiet, "all", "back", t_heard),
        ("sensor", t_heard + STALE_S, "all", "stopped", None),
        ("sensor", t_lux_back, "light", "back", t_back),
        ("sensor", t_lux, "light", "stopped", None),
        ("sensor", t_back, "all", "back", t0),
        ("device", t_off, None, "off", None),
        ("sensor", t_gone, "all", "stopped", None),
        ("device", t_on, None, "on", None),
    ]
    sensor_rows = [e for e in result["entries"] if e["kind"] == "sensor"]
    assert all(e["sensor"] == "s1" and e["name"] == "Left" for e in sensor_rows)
    # The test's recorder started just before t0, so the early rows read as a restart's and the late ones don't.
    assert [e.get("cause") for e in sensor_rows if e["when"] in (t_gone, t_quiet)] == [None, {"type": "startup"}]
    allowed = {"kind", "when", "sensor", "name", "reading", "state", "since", "cause"}
    assert all(set(e) <= allowed for e in sensor_rows)
    text = json.dumps(result)
    for secret in (*LEFT.values(), RIGHT, VEG, "s2", *VALUES.values(), "40000", "19.5", "18.25"):
        assert secret not in text


async def test_a_reading_stopped_before_the_page_shows_only_its_return(room, hass, freezer, monkeypatch) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (HEATER, "off"), (RIGHT, "19.5"), ("sensor.left_temp", "20.5"))
    t_gone = await clock.at(5, (RIGHT, "unavailable"), ("sensor.left_temp", "unavailable"))
    t_back = await clock.at(activity.LOOK_BACK_S + 100, ("sensor.left_temp", "21.5"))
    await async_wait_recording_done(hass)

    # Right is stopped all through the page and Left stopped before it: only Left's return, and when it last read is
    # further back than the page reaches.
    result = await room(zone="garden", start=t_gone + activity.LOOK_BACK_S + 60, end=t_back + 1)
    assert [(e["reading"], e["state"], e.get("since")) for e in result["entries"]] == [("temperature", "back", None)]

    # A page that reaches the stop, read in slices too short for the return's look-back to reach it, pairs them.
    monkeypatch.setattr(activity, "SLICE_HOURS", 60 / 3600)
    result = await room(zone="garden", start=t0 - 60, end=t_back + 1)
    assert [(e["when"], e["sensor"], e["reading"], e["state"], e.get("since")) for e in result["entries"]] == [
        (t_back, "s1", "temperature", "back", t0),
        (t_gone, "s3", "temperature", "stopped", None),
        (t_gone, "s1", "temperature", "stopped", None),
    ]


async def test_a_sensor_of_another_zone_never_appears(room, hass, freezer) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (VEG, "18.25"), (HEATER, "off"))
    await clock.at(1, (VEG, "unavailable"))
    t_end = await clock.at(1, (VEG, "18.5"))
    await async_wait_recording_done(hass)
    assert (await room(zone="garden", start=t0 - 60, end=t_end + 1))["entries"] == []
    veg = await room(zone="veg", start=t0 - 60, end=t_end + 1)
    assert [(e["sensor"], e["state"]) for e in veg["entries"]] == [("s2", "back"), ("s2", "stopped")]


async def test_the_cap_and_cursor_take_each_sensor_row_once(room, hass, freezer, monkeypatch) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (HEATER, "off"), (RIGHT, "19.5"))
    for i in range(4):
        await clock.at(1, (RIGHT, "unavailable"))
        await clock.at(1, (HEATER, "on" if i % 2 == 0 else "off"))
        await clock.at(1, (RIGHT, f"19.{i}"))
    t_end = clock.now.timestamp() + 1
    await async_wait_recording_done(hass)
    whole = (await room(zone="garden", start=t0 - 60, end=t_end))["entries"]
    assert len(whole) == 12 and sum(e["kind"] == "sensor" for e in whole) == 8

    monkeypatch.setattr(activity, "MAX_ENTRIES", 5)
    monkeypatch.setattr(activity, "SLICE_HOURS", 3 / 3600)
    pages, end = [], t_end
    while True:
        page = await room(zone="garden", start=t0 - 60, end=end)
        pages.append(page["entries"])
        if not page["more"]:
            break
        end = page["next_end"]
        assert all(e["when"] >= end for e in page["entries"])
    assert len(pages) == 3
    assert [e for p in pages for e in p] == whole


async def _direct(hass, start, end):
    # Straight to the read, not over the socket: these histories run longer than a test's access token lives.
    zone = activity.zone_entities(ROOM, "garden")
    result = await activity.async_activity(hass, "garden", zone, start, end)
    return [(e["when"], e["reading"], e["state"]) for e in result["entries"] if e["kind"] == "sensor"]


async def test_a_value_reported_again_unchanged_is_not_silence(room, hass, freezer) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (RIGHT, "19.5"))
    # Home Assistant writes no row for these, only moves the state's last report.
    for _ in range(10):
        await clock.at(STALE_S / 4, (RIGHT, "19.5"))
    t_end = await clock.at(60, (RIGHT, "19.6"))
    await async_wait_recording_done(hass)
    assert await _direct(hass, t0 - 60, t_end + 1) == []


async def test_a_steady_reading_still_current_is_not_silence(room, hass, freezer) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (RIGHT, "19.5"))
    for _ in range(10):
        t_end = await clock.at(STALE_S / 4, (RIGHT, "19.5"))
    await async_wait_recording_done(hass)
    # Its last report is held only by the live state until the next change is recorded.
    assert await _direct(hass, t0 - 60, t_end + 1) == []


async def test_a_reporting_reading_that_goes_silent_stops_at_its_last_report(room, hass, freezer) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (RIGHT, "19.5"))
    t_heard = await clock.at(60, (RIGHT, "19.5"))
    t_back = await clock.at(30 * 60, (RIGHT, "19.6"))
    await async_wait_recording_done(hass)
    assert await _direct(hass, t0 - 60, t_back + 1) == [
        (t_back, "temperature", "back"),
        (t_heard + STALE_S, "temperature", "stopped"),
    ]


async def test_a_forced_update_reading_that_goes_silent_stops(room, hass, freezer) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0)
    # force_update writes the same value again as a new row.
    for _ in range(3):
        t_last = await clock.at(10)
        hass.states.async_set(RIGHT, "19.5", force_update=True)
    t_back = await clock.at(30 * 60, (RIGHT, "19.6"))
    await async_wait_recording_done(hass)
    assert await _direct(hass, t0 - 60, t_back + 1) == [
        (t_back, "temperature", "back"),
        (t_last + STALE_S, "temperature", "stopped"),
    ]


async def test_a_reading_that_writes_only_changes_is_judged_by_its_states(room, hass, freezer) -> None:
    # As MQTT and Zigbee sensors do: a value that holds moves nothing, so silence can't be told from steadiness.
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (RIGHT, "19.5"))
    t_gone = await clock.at(60 * 60, (RIGHT, "unavailable"))
    t_back = await clock.at(60, (RIGHT, "19.6"))
    t_end = await clock.at(30 * 60, (HEATER, "on"))
    await async_wait_recording_done(hass)
    assert await _direct(hass, t0 - 60, t_end + 1) == [
        (t_back, "temperature", "back"),
        (t_gone, "temperature", "stopped"),
    ]


def test_a_reading_current_across_a_restart_counts_as_reporting_up_to_it() -> None:
    # The recorder never stores the last report of a row current when Home Assistant stopped.
    rows = _rows((0, "20"), (5000, "unavailable"), (5100, "21"))
    assert activity.turns(rows, 5500, [4990]) == [Turn(5000, "stopped", None), Turn(5100, "back", None)]
    assert activity.turns(rows, 5500) == [Turn(STALE_S, "stopped", 0), Turn(5100, "back", 0)]
    # A repeat across a restart is the restart writing every state anew, not force_update.
    assert activity.proves_timed(_rows((0, "20"), (100, "20")), [50]) is False
    assert activity.proves_timed(_rows((0, "20"), (100, "20")), []) is True


async def test_readings_stopping_half_a_second_apart_across_a_slice_edge_are_one_row(
    room, hass, freezer, monkeypatch
) -> None:
    monkeypatch.setattr(activity, "SLICE_HOURS", 4 / 3600)
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, *_left())
    t_gone = await clock.at(5, *_left("unavailable")[:2])
    await clock.at(0.5, *_left("unavailable")[2:])
    # A slice starts between the two halves.
    result = await room(zone="garden", start=t0 - 60, end=t_gone + 0.25 + 4 * 3)
    assert [(e["when"], e["reading"], e["state"]) for e in result["entries"]] == [(t_gone, "all", "stopped")]


async def test_a_stop_at_the_cursor_beside_a_logbook_row_is_taken_once(room, hass, freezer, monkeypatch) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (HEATER, "off"), (RIGHT, "19.5"), ("sensor.left_temp", "20.5"))
    await clock.at(1, (HEATER, "on"))
    # The cap is met on the first of the three rows at this time; the other two still belong to this page.
    t_both = await clock.at(1, (HEATER, "off"), (RIGHT, "unavailable"), ("sensor.left_temp", "unavailable"))
    t_end = await clock.at(1, (HEATER, "on"))
    await async_wait_recording_done(hass)
    whole = (await room(zone="garden", start=t0 - 60, end=t_end + 1))["entries"]

    monkeypatch.setattr(activity, "MAX_ENTRIES", 2)
    first = await room(zone="garden", start=t0 - 60, end=t_end + 1)
    assert first["more"] is True and first["next_end"] == t_both
    second = await room(zone="garden", start=t0 - 60, end=first["next_end"])
    assert [e for e in first["entries"] + second["entries"] if e["kind"] == "sensor"] == [
        e for e in whole if e["kind"] == "sensor"
    ]
    assert [e["when"] for e in first["entries"] + second["entries"]] == [e["when"] for e in whole]


async def test_a_reading_silent_across_several_slices_stops_once(room, hass, freezer, monkeypatch) -> None:
    monkeypatch.setattr(activity, "SLICE_HOURS", 120 / 3600)
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (RIGHT, "19.5"))
    t_heard = await clock.at(30, (RIGHT, "19.5"))
    t_end = await clock.at(STALE_S + 15 * 60, (HEATER, "on"))
    await async_wait_recording_done(hass)
    assert await _direct(hass, t0 - 60, t_end + 1) == [(t_heard + STALE_S, "temperature", "stopped")]
