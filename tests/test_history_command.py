"""The history command, against HA's own recorder: it serves only mapped readings, over a range the panel draws."""

from datetime import timedelta

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.recorder.common import async_wait_recording_done

from custom_components.environment_control.const import DOMAIN


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(recorder_mock, enable_custom_integrations):
    """The recorder has to start before HA does, so it comes ahead of the shared fixture here."""
    return


ROOM = {
    "zones": [
        {
            "id": "garden",
            "name": "Garden",
            "sensors": [{"id": "s1", "name": "Left", "kind": "env", "entities": {"temperature": "sensor.left_temp"}}],
        }
    ],
    "devices": [],
}


@pytest.fixture
async def room(hass: HomeAssistant, hass_ws_client):
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/config/save", "revision": 0, "config": ROOM})
    assert (await client.receive_json())["success"]
    return client


async def _history(client, **msg):
    await client.send_json_auto_id({"type": f"{DOMAIN}/history", **msg})
    return await client.receive_json()


async def test_a_mapped_reading_comes_back_bucketed_with_dead_and_stale_stretches_left_empty(
    room, hass, hass_ws_client, freezer
) -> None:
    # Readings written into the last hour, then back to now, so the panel's login is still current when it asks.
    now = dt_util.utcnow().replace(microsecond=0)
    base = now - timedelta(minutes=60)
    for i in range(180):
        freezer.move_to(base + timedelta(seconds=10 * i))
        hass.states.async_set("sensor.left_temp", str(20 + i % 2))
        await hass.async_block_till_done()
    freezer.move_to(base + timedelta(minutes=30))
    hass.states.async_set("sensor.left_temp", "unavailable")
    await hass.async_block_till_done()
    freezer.move_to(now)
    await async_wait_recording_done(hass)

    r = await _history(await hass_ws_client(hass), entities=["sensor.left_temp"], hours=4, buckets=12)
    assert r["success"], r
    series = r["result"]["series"]["sensor.left_temp"]
    values = series["values"]
    # Four hours ending now in 20 minute buckets: the readings began an hour ago, in bucket 9.
    assert values[:9] == [None] * 9
    assert values[9] == [20.5, 20.0, 21.0]
    assert values[10] == [20.5, 20.0, 21.0]
    assert values[11] is None
    assert series["first"] == pytest.approx(base.timestamp(), abs=1)


@pytest.mark.parametrize(
    ("msg", "code"),
    [
        ({"entities": ["sensor.kitchen_temp"], "hours": 24, "buckets": 300}, "unauthorized"),
        ({"entities": ["switch.heater"], "hours": 24, "buckets": 300}, "unauthorized"),
        ({"entities": [], "hours": 24, "buckets": 300}, "unauthorized"),
        ({"entities": ["sensor.left_temp"], "hours": 720, "buckets": 300}, "invalid_format"),
        ({"entities": ["sensor.left_temp"], "hours": 24, "buckets": 100_000}, "invalid_format"),
    ],
)
async def test_only_mapped_readings_over_a_drawn_range_are_served(room, msg, code) -> None:
    r = await _history(room, **msg)
    assert not r["success"]
    assert r["error"]["code"] == code


async def test_history_is_for_admins_only(room, hass, hass_ws_client, hass_read_only_access_token) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    r = await _history(client, entities=["sensor.left_temp"], hours=24, buckets=300)
    assert not r["success"]
    assert r["error"]["code"] == "unauthorized"
