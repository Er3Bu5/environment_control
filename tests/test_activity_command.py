"""The activity command, against HA's own recorder and logbook: one zone's devices and linked automations, a page at a
time, with causes put in words and repeated runs collapsed."""

import asyncio
import time
from datetime import timedelta

import pytest
from homeassistant.components.automation import EVENT_AUTOMATION_TRIGGERED
from homeassistant.core import Context, HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.recorder.common import async_wait_recording_done

from custom_components.environment_control import activity
from custom_components.environment_control.const import DOMAIN


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(recorder_mock, enable_custom_integrations):
    """The recorder has to start before HA does, so it comes ahead of the shared fixture here."""
    return


HEATER, FAN, ALERT, OTHER = (
    "switch.garden_heater",
    "switch.veg_fan",
    "automation.garden_heat_alert",
    "automation.veg_alert",
)
ROOM = {
    "zones": [
        {
            "id": "garden",
            "name": "Garden",
            "sensors": [{"id": "s1", "name": "Left", "kind": "env", "entities": {"temperature": "sensor.left_temp"}}],
            "automations": [{"id": "a1", "entity": ALERT, "group": "alert_day"}],
        },
        {"id": "veg", "name": "Veg", "automations": [{"id": "a2", "entity": OTHER, "group": "alert_day"}]},
    ],
    "devices": [
        {"id": "d1", "name": "Heater", "zones": ["garden"], "entity": HEATER},
        {"id": "d2", "name": "Fan", "zones": ["veg"], "entity": FAN},
    ],
}


async def _setup(hass: HomeAssistant, hass_ws_client, logbook: bool):
    if logbook:
        assert await async_setup_component(hass, "automation", {})
        assert await async_setup_component(hass, "logbook", {})
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/config/save", "revision": 0, "config": ROOM})
    assert (await client.receive_json())["success"]
    return client


@pytest.fixture
async def room(hass: HomeAssistant, hass_ws_client):
    return await _setup(hass, hass_ws_client, logbook=True)


async def _activity(client, **msg):
    await client.send_json_auto_id({"type": f"{DOMAIN}/activity", **msg})
    return await client.receive_json()


def _day(**extra):
    end = dt_util.utcnow().timestamp() + 1
    return {"zone": "garden", "start": end - 86400, "end": end, **extra}


class Clock:
    """Moves frozen time on a second per step, so the log's order is the order written."""

    def __init__(self, hass, freezer, start):
        self.hass, self.freezer, self.now = hass, freezer, start

    async def step(self, fn):
        self.now += timedelta(seconds=1)
        self.freezer.move_to(self.now)
        fn()
        await self.hass.async_block_till_done()


def _run(hass, entity, source, context=None, name="Garden heat alert"):
    return lambda: hass.bus.async_fire(
        EVENT_AUTOMATION_TRIGGERED, {"name": name, "entity_id": entity, "source": source}, context=context
    )


def _set(hass, entity, state, context=None, **attrs):
    return lambda: hass.states.async_set(entity, state, attrs, context=context)


async def test_a_zone_page_through_the_real_logbook(room, hass, hass_ws_client, freezer) -> None:
    pat = await hass.auth.async_create_user("Pat")
    # Past the window where a change with no cause is put down to Home Assistant starting.
    clock = Clock(hass, freezer, dt_util.utcnow().replace(microsecond=0) + timedelta(minutes=10))
    for entity, state in ((HEATER, "off"), (FAN, "off"), (ALERT, "on"), (OTHER, "on")):
        await clock.step(_set(hass, entity, state))
    await clock.step(_set(hass, "sensor.left_temp", "20", unit_of_measurement="°C", state_class="measurement"))

    house = Context()
    await clock.step(_run(hass, "automation.house_lights", "time", house, name="House lights"))
    await clock.step(_set(hass, HEATER, "on", house))
    alert = Context()
    await clock.step(_run(hass, ALERT, "state of sensor.left_temp", alert))
    await clock.step(_set(hass, HEATER, "off", alert))
    for _ in range(2):
        await clock.step(_run(hass, ALERT, "state of sensor.left_temp"))
        await clock.step(_set(hass, "sensor.left_temp", "21", unit_of_measurement="°C", state_class="measurement"))
        await clock.step(_set(hass, FAN, "on"))
        await clock.step(_run(hass, OTHER, "time pattern", name="Veg alert"))
    await clock.step(_set(hass, HEATER, "on", Context(user_id=pat.id)))
    await clock.step(_set(hass, HEATER, "unavailable"))
    await clock.step(_set(hass, HEATER, "on"))
    await clock.step(_set(hass, ALERT, "off", Context(user_id=pat.id)))
    await async_wait_recording_done(hass)

    r = await _activity(await hass_ws_client(hass), **_day())
    assert r["success"], r
    result = r["result"]
    assert result["zone"] == "garden" and result["more"] is False and result["next_end"] is None
    assert result["earliest"] == pytest.approx(clock.now.timestamp() - 168 * 3600, abs=2)
    entries = result["entries"]
    for e in entries:
        e.pop("when")
        e.pop("name")
    t = clock.now.timestamp()
    assert entries == [
        {"kind": "automation", "entity": ALERT, "state": "off", "cause": {"type": "person", "name": "Pat"}},
        {"kind": "device", "entity": HEATER, "state": "on", "cause": {"type": "reconnect"}},
        {"kind": "device", "entity": HEATER, "state": "unavailable", "cause": {"type": "none"}},
        {"kind": "device", "entity": HEATER, "state": "on", "cause": {"type": "person", "name": "Pat"}},
        # Three runs on one trigger, with other zones' and the sensor's entries in between, are one row.
        {
            "kind": "run",
            "entity": ALERT,
            "trigger": {"kind": "state", "name": "Left"},
            "count": 3,
            "first": t - 13,
            "last": t - 7,
        },
        {
            "kind": "device",
            "entity": HEATER,
            "state": "off",
            "cause": {
                "type": "automation",
                "name": "Garden heat alert",
                "trigger": {"kind": "state", "name": "Left"},
                "entity": ALERT,
            },
        },
        # An automation the zone doesn't link is named, with its kind of trigger, but its id isn't sent.
        {
            "kind": "device",
            "entity": HEATER,
            "state": "on",
            "cause": {"type": "automation", "name": "House lights", "trigger": {"kind": "time"}},
        },
    ]
    assert all(e["entity"] not in (FAN, OTHER, "sensor.left_temp") for e in entries)
    assert pat.id not in str(result)


def test_the_zone_asks_only_for_its_devices_and_linked_automations_never_its_sensors() -> None:
    assert activity.zone_entities(ROOM, "garden") == ([HEATER], {ALERT}, {"sensor.left_temp": "Left", HEATER: "Heater"})
    assert activity.zone_entities(ROOM, "kitchen") is None


def test_a_streak_is_broken_by_another_trigger_or_another_entry_of_its_automation_only() -> None:
    def run(when, source="time", entity=ALERT):
        return {"when": when, "entity_id": entity, "domain": "automation", "name": "A", "source": source}

    rows = [
        run(1),
        run(2),
        {"when": 3, "entity_id": HEATER, "state": "on", "name": "Heater"},
        run(4),
        run(5, source="state of sensor.left_temp"),
        run(6),
        {"when": 7, "entity_id": ALERT, "state": "off", "name": "A"},
        run(8),
        run(9, entity=OTHER),
    ]
    collapse = activity.Collapse({HEATER}, {ALERT}, {}, activity.MAX_ENTRIES)
    assert collapse.feed(rows, {}, [])
    runs = [(e["count"], e["first"], e["last"], e["trigger"]["kind"]) for e in collapse.entries if e["kind"] == "run"]
    assert runs == [(1, 8, 8, "time"), (1, 6, 6, "time"), (1, 5, 5, "state"), (3, 1, 4, "time")]
    assert [e["kind"] for e in collapse.entries] == ["run", "automation", "run", "run", "run", "device"]
    assert collapse.more is False


async def test_a_change_with_no_cause_just_after_home_assistant_starts_is_put_down_to_the_start(
    room, hass, hass_ws_client
) -> None:
    hass.states.async_set(HEATER, "off")
    await hass.async_block_till_done()
    hass.states.async_set(HEATER, "on")
    await async_wait_recording_done(hass)
    r = await _activity(room, **_day())
    assert r["success"], r
    assert [e["cause"] for e in r["result"]["entries"]] == [{"type": "startup"}]


async def test_the_cap_keeps_the_newest_rows_and_says_more_exist(room, hass, freezer, monkeypatch) -> None:
    monkeypatch.setattr(activity, "MAX_ENTRIES", 2)
    clock = Clock(hass, freezer, dt_util.utcnow().replace(microsecond=0) + timedelta(minutes=10))
    for state in ("off", "on", "off", "on"):
        await clock.step(_set(hass, HEATER, state))
    await async_wait_recording_done(hass)
    r = await _activity(room, **_day())
    assert r["success"], r
    assert r["result"]["more"] is True and r["result"]["next_end"] == clock.now.timestamp() - 1
    assert [(e["state"], e["when"]) for e in r["result"]["entries"]] == [
        ("on", clock.now.timestamp()),
        ("off", clock.now.timestamp() - 1),
    ]


@pytest.mark.parametrize(
    ("msg", "code"),
    [
        (_day(zone="kitchen"), "not_found"),
        (_day(zone=HEATER), "not_found"),
        (_day(entities=[HEATER]), "invalid_format"),
        (_day(entity_id=HEATER), "invalid_format"),
        ({"zone": "garden", "start": 0, "end": 25 * 3600 + 1}, "invalid_format"),
        ({"zone": "garden", "start": time.time() - 26 * 3600, "end": time.time()}, "invalid_format"),
        ({"zone": "garden", "start": time.time() - 170 * 3600, "end": time.time() - 168 * 3600}, "invalid_format"),
        ({"zone": "garden", "start": 100, "end": 100}, "invalid_format"),
        ({"zone": "garden", "start": 1e30, "end": 1e30 + 1}, "invalid_format"),
    ],
)
async def test_only_a_zone_of_the_setup_over_one_page_is_served(room, msg, code) -> None:
    r = await _activity(room, **msg)
    assert not r["success"]
    assert r["error"]["code"] == code


@pytest.mark.parametrize("before_s", [0, 60])
async def test_a_page_reaching_past_the_lookback_starts_at_its_edge(room, before_s) -> None:
    edge = time.time() - 168 * 3600
    r = await _activity(room, zone="garden", start=edge - before_s, end=edge + 3600)
    assert r["success"], r
    assert r["result"]["start"] == r["result"]["earliest"] == pytest.approx(edge, abs=5)
    # A page that ends at the edge has nothing left to show.
    r = await _activity(room, zone="garden", start=edge - 3600, end=edge)
    assert r["error"]["code"] == "invalid_format"
    # The same limit is History's longest range.
    await room.send_json_auto_id(
        {"type": f"{DOMAIN}/history", "entities": ["sensor.left_temp"], "hours": 168, "buckets": 300}
    )
    assert (await room.receive_json())["success"]


async def test_activity_is_for_admins_only(room, hass, hass_ws_client, hass_read_only_access_token) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    r = await _activity(client, **_day())
    assert r["error"]["code"] == "unauthorized"


async def test_without_the_logbook_activity_says_so(hass, hass_ws_client) -> None:
    client = await _setup(hass, hass_ws_client, logbook=False)
    r = await _activity(client, **_day())
    assert r["error"]["code"] == "no_logbook"


async def test_a_slow_logbook_gives_a_clear_error(room, monkeypatch) -> None:
    def slow(*_args):
        time.sleep(0.5)
        return [], []

    monkeypatch.setattr(activity, "QUERY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(activity, "_read", slow)
    r = await _activity(room, **_day())
    assert r["error"] == {"code": "timeout", "message": "Home Assistant's logbook took too long to answer. Try again."}


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("state of person.alice", {"kind": "state"}),
        ("numeric state of sensor.outside_temp", {"kind": "numeric_state"}),
        ("mqtt topic home/alice/phone", {"kind": "mqtt"}),
        ("person.alice entering Alice's work", {"kind": "zone"}),
        ("device_tracker.alice_phone leaving Home", {"kind": "zone"}),
        ("geo_location - quakes near home", {"kind": "geo_location"}),
        ("event 'alice_arrived'", {"kind": "event"}),
        ("time set in input_datetime.alice_alarm", {"kind": "time"}),
        ("binary_sensor.alice_door via template", {"kind": "template"}),
        ("Home Assistant starting", {"kind": "homeassistant"}),
        ("time pattern", {"kind": "time_pattern"}),
        ("something new from alice", {"kind": "other"}),
        (None, {"kind": "other"}),
        ("state of sensor.left_temp", {"kind": "state", "name": "Left"}),
        ("numeric state of sensor.left_temp", {"kind": "numeric_state", "name": "Left"}),
        ("time set in switch.garden_heater", {"kind": "time", "name": "Heater"}),
        # The zone's own entity, but not all of what follows it.
        ("state of sensor.left_temp and person.alice", {"kind": "state"}),
    ],
)
def test_a_trigger_is_sent_as_its_kind_named_only_for_the_zones_own(source, expected) -> None:
    _, _, names = activity.zone_entities(ROOM, "garden")
    assert activity.trigger(source, names) == expected


async def test_nothing_of_an_outside_trigger_leaves_but_its_kind(room, hass, hass_ws_client, freezer) -> None:
    clock = Clock(hass, freezer, dt_util.utcnow().replace(microsecond=0) + timedelta(minutes=10))
    await clock.step(_set(hass, HEATER, "off"))
    for source in ("state of person.alice", "mqtt topic home/alice/phone", "person.alice entering Alice's work"):
        await clock.step(_run(hass, ALERT, source))
    outside = Context()
    await clock.step(_run(hass, "automation.house_lights", "state of person.alice", outside, name="House lights"))
    await clock.step(_set(hass, HEATER, "on", outside))
    await async_wait_recording_done(hass)
    r = await _activity(room, **_day())
    assert r["success"], r
    entries = r["result"]["entries"]
    assert entries[0]["cause"]["trigger"] == {"kind": "state"}
    assert [e["trigger"] for e in entries[1:]] == [{"kind": "zone"}, {"kind": "mqtt"}, {"kind": "state"}]
    assert "alice" not in str(r["result"]).lower()


async def test_pages_follow_the_cursor_with_every_run_and_change_counted_once(room, hass, freezer, monkeypatch) -> None:
    monkeypatch.setattr(activity, "MAX_ENTRIES", 3)
    # Slices of a few seconds, so rows fall on their edges too.
    monkeypatch.setattr(activity, "SLICE_HOURS", 3 / 3600)
    read = activity._read
    reads = []
    monkeypatch.setattr(activity, "_read", lambda *a: reads.append(a[2]) or read(*a))
    first = dt_util.utcnow().replace(microsecond=0) + timedelta(minutes=10)
    clock = Clock(hass, freezer, first)
    await clock.step(_set(hass, HEATER, "off"))
    changes = []
    for state in ("on", "off", None, "on", "off", None):
        await clock.step(_run(hass, ALERT, "time pattern"))
        if state:
            await clock.step(_set(hass, HEATER, state))
            changes.append(clock.now.timestamp())
    await async_wait_recording_done(hass)
    start, end = first.timestamp() - 60, clock.now.timestamp() + 1

    r = await _activity(room, zone="garden", start=start, end=end)
    assert r["success"], r
    page = r["result"]
    assert page["more"] is True
    # Reading stopped once the page was full, well short of its start.
    assert min(reads) > start + 30
    r = await _activity(room, zone="garden", start=start, end=page["next_end"])
    assert r["success"], r
    older = r["result"]
    assert older["more"] is False and older["next_end"] is None

    entries = page["entries"] + older["entries"]
    assert sum(e["count"] for e in entries if e["kind"] == "run") == 6
    assert sorted(e["when"] for e in entries if e["kind"] == "device") == changes
    assert all(e["first"] >= page["next_end"] for e in page["entries"] if e["kind"] == "run")


async def test_a_cause_on_record_wins_over_home_assistant_starting(room, hass) -> None:
    pat = await hass.auth.async_create_user("Pat")
    alert = Context()
    for step in (
        _set(hass, HEATER, "off"),
        _set(hass, HEATER, "on", Context(user_id=pat.id)),
        _run(hass, ALERT, "state of sensor.left_temp", alert),
        _set(hass, HEATER, "off", alert),
        _set(hass, HEATER, "on"),
    ):
        step()
        await hass.async_block_till_done()
    await async_wait_recording_done(hass)
    r = await _activity(room, **_day())
    assert r["success"], r
    causes = [e["cause"]["type"] for e in r["result"]["entries"] if e["kind"] == "device"]
    assert causes == ["startup", "automation", "person"]


def _slow_read(calls, seconds):
    def slow(*_args):
        calls.append(1)
        time.sleep(seconds)
        return [], []

    return slow


async def _send(client, **msg):
    await client.send_json_auto_id({"type": f"{DOMAIN}/activity", **msg})


async def _answers(client, n):
    return sorted([await client.receive_json() for _ in range(n)], key=lambda r: r["id"])


async def test_the_same_page_asked_twice_is_read_once(room, monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(activity, "SLICE_HOURS", 25)
    monkeypatch.setattr(activity, "_read", _slow_read(calls, 0.3))
    msg = _day()
    await _send(room, **msg)
    await _send(room, **msg)
    first, second = await _answers(room, 2)
    assert first["success"] and second["success"], (first, second)
    assert first["result"] == second["result"]
    assert len(calls) == 1


async def test_another_page_while_one_is_read_is_told_busy(room, monkeypatch) -> None:
    monkeypatch.setattr(activity, "SLICE_HOURS", 25)
    monkeypatch.setattr(activity, "_read", _slow_read([], 0.3))
    msg = _day()
    await _send(room, **msg)
    await _send(room, **{**msg, "end": msg["end"] - 60})
    first, second = await _answers(room, 2)
    assert first["success"], first
    assert second["error"]["code"] == "busy"


async def test_a_read_that_timed_out_holds_its_place_until_its_thread_is_done(room, monkeypatch) -> None:
    monkeypatch.setattr(activity, "SLICE_HOURS", 25)
    monkeypatch.setattr(activity, "QUERY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(activity, "_read", _slow_read([], 0.5))
    msg = _day()
    assert (await _activity(room, **msg))["error"]["code"] == "timeout"
    assert (await _activity(room, **{**msg, "end": msg["end"] - 60}))["error"]["code"] == "busy"
    await asyncio.sleep(0.6)
    monkeypatch.setattr(activity, "_read", _slow_read([], 0))
    assert (await _activity(room, **{**msg, "end": msg["end"] - 60}))["success"]
