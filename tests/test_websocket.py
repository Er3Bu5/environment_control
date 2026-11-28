"""The panel's backend commands: admin only, revision-checked, validated, and stored."""

import asyncio
import copy

import pytest
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.environment_control.const import DOMAIN
from custom_components.environment_control.store import ConfigStore, RevisionConflict


@pytest.fixture
async def loaded(hass: HomeAssistant) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _send(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


async def test_a_first_install_has_no_zones(hass, loaded, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["success"] and r["result"] == {"revision": 0, "zones": [], "devices": []}


async def test_a_save_is_stored_and_moves_the_revision_on(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    sample_config = sample_unlinked
    client = await hass_ws_client(hass)
    cfg = {"zones": sample_config["zones"], "devices": sample_config["devices"]}
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=cfg)
    assert r["success"], r
    assert r["result"]["revision"] == 1
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"]["revision"] == 1
    assert [z["id"] for z in hass_storage[DOMAIN]["data"]["zones"]] == [z["id"] for z in sample_config["zones"]]
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["result"]["revision"] == 1


async def test_a_save_survives_reloading_the_integration(hass, loaded, hass_ws_client, sample_unlinked) -> None:
    sample_config = sample_unlinked
    client = await hass_ws_client(hass)
    cfg = {"zones": sample_config["zones"], "devices": sample_config["devices"]}
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=cfg))["success"]
    assert await hass.config_entries.async_reload(loaded.entry_id)
    await hass.async_block_till_done()
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["result"]["revision"] == 1 and len(r["result"]["zones"]) == len(sample_config["zones"])


async def test_a_save_from_a_stale_copy_is_refused(hass, loaded, hass_ws_client, hass_storage) -> None:
    client = await hass_ws_client(hass)
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": [], "devices": []}))[
        "success"
    ]
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": [{"id": "late"}], "devices": []})
    assert not r["success"] and r["error"]["code"] == "revision_conflict"
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"]["zones"] == []


async def test_an_invalid_setup_is_refused_and_nothing_is_stored(
    hass, loaded, hass_ws_client, hass_storage, sample_config
) -> None:
    client = await hass_ws_client(hass)
    bad = copy.deepcopy({"zones": sample_config["zones"], "devices": sample_config["devices"]})
    bad["devices"].append({"id": "lock", "zones": [bad["zones"][0]["id"]], "entity": "lock.front_door"})
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=bad)
    assert not r["success"] and r["error"]["code"] == "invalid_config"
    assert "can't control" in r["error"]["message"]
    await hass.async_block_till_done()
    assert DOMAIN not in hass_storage


async def test_a_malformed_message_is_refused(hass, loaded, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config/save", revision="1", config={})
    assert not r["success"] and r["error"]["code"] == "invalid_format"


async def test_both_commands_are_for_admins_only(hass, loaded, hass_ws_client, hass_read_only_access_token) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    for msg in (
        {"type": f"{DOMAIN}/config"},
        {"type": f"{DOMAIN}/config/save", "revision": 0, "config": {"zones": [], "devices": []}},
    ):
        r = await _send(client, **msg)
        assert not r["success"] and r["error"]["code"] == "unauthorized"


async def test_commands_say_so_when_the_integration_is_not_loaded(hass, loaded, hass_ws_client) -> None:
    assert await hass.config_entries.async_unload(loaded.entry_id)
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config")
    assert not r["success"] and r["error"]["code"] == "not_loaded"


async def test_automation_links_and_the_room_setting_are_stored_and_read_back(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    links = [
        {"id": "a1", "entity": "automation.critical_garden_humidity_high_day", "group": "alert_day"},
        {"id": "a2", "entity": "automation.failsafe_garden_lights_recovery", "group": "failsafe"},
    ]
    room = {"alertRepeat": "input_number.alert_repeat_rate"}
    zones = copy.deepcopy(sample_unlinked["zones"])
    zones[0]["automations"] = links
    client = await hass_ws_client(hass)
    # A revision sent inside the setup is ignored: the store sets its own.
    cfg = {"zones": zones, "devices": sample_unlinked["devices"], "room": room, "revision": 99}
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=cfg)
    assert r["success"], r
    assert r["result"]["revision"] == 1
    await hass.async_block_till_done()
    stored = hass_storage[DOMAIN]["data"]
    assert stored["zones"][0]["automations"] == links and stored["room"] == room and stored["revision"] == 1
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["result"]["zones"][0]["automations"] == links and r["result"]["room"] == room


async def test_a_link_to_anything_but_an_automation_is_refused_and_nothing_is_stored(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    zones = copy.deepcopy(sample_unlinked["zones"])
    zones[0]["automations"] = [{"id": "a1", "entity": "switch.reservoir_pump", "group": "failsafe"}]
    client = await hass_ws_client(hass)
    r = await _send(
        client,
        type=f"{DOMAIN}/config/save",
        revision=0,
        config={"zones": zones, "devices": sample_unlinked["devices"]},
    )
    assert not r["success"] and r["error"]["code"] == "invalid_config"
    assert "isn't an automation" in r["error"]["message"]
    assert DOMAIN not in hass_storage
    assert (await _send(client, type=f"{DOMAIN}/config"))["result"]["revision"] == 0


async def test_an_automation_linked_by_a_second_zone_is_refused_and_nothing_is_stored(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    link = {"id": "a1", "entity": "automation.failsafe_veg_fans_auto_on", "group": "failsafe"}
    zones = copy.deepcopy(sample_unlinked["zones"])
    zones[1]["automations"] = [dict(link)]
    zones[2]["automations"] = [dict(link)]
    client = await hass_ws_client(hass)
    r = await _send(
        client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": zones, "devices": sample_unlinked["devices"]}
    )
    assert not r["success"] and r["error"]["code"] == "invalid_config"
    assert r["error"]["message"] == "An automation can only be linked to one zone."
    await hass.async_block_till_done()
    assert DOMAIN not in hass_storage


async def test_an_automation_moves_zone_in_two_saves(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    """Unlinked where it is in one save, then linked in the new zone in the next."""
    link = {"id": "a1", "entity": "automation.failsafe_veg_fans_auto_on", "group": "failsafe"}
    zones = copy.deepcopy(sample_unlinked["zones"])
    zones[1]["automations"] = [dict(link)]
    zones[2]["automations"] = []
    devices = sample_unlinked["devices"]
    client = await hass_ws_client(hass)
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": zones, "devices": devices}))[
        "success"
    ]
    zones[2]["automations"] = [dict(link)]
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=1, config={"zones": zones, "devices": devices})
    assert not r["success"] and r["error"]["message"] == "An automation can only be linked to one zone."
    zones[1]["automations"] = []
    zones[2]["automations"] = []
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=1, config={"zones": zones, "devices": devices}))[
        "success"
    ]
    zones[2]["automations"] = [dict(link)]
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=2, config={"zones": zones, "devices": devices}))[
        "success"
    ]
    await hass.async_block_till_done()
    stored = hass_storage[DOMAIN]["data"]
    assert stored["revision"] == 3
    assert [z.get("automations") for z in stored["zones"][1:]] == [[], [link]]


async def test_a_setup_stored_before_the_one_zone_rule_loads_and_cannot_be_saved_as_it_is(
    hass, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    """Pins today's behaviour: no screen ever stored one automation in two zones, so there is no migration."""
    link = {"id": "a1", "entity": "automation.failsafe_veg_fans_auto_on", "group": "failsafe"}
    zones = copy.deepcopy(sample_unlinked["zones"])
    zones[1]["automations"] = [dict(link)]
    zones[2]["automations"] = [dict(link)]
    stored = {"revision": 4, "zones": zones, "devices": sample_unlinked["devices"]}
    hass_storage[DOMAIN] = {"version": 1, "minor_version": 1, "key": DOMAIN, "data": copy.deepcopy(stored)}
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["success"] and r["result"] == stored
    config = {"zones": zones, "devices": sample_unlinked["devices"]}
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=4, config=config)
    assert not r["success"] and r["error"]["code"] == "invalid_config"
    assert r["error"]["message"] == "An automation can only be linked to one zone."
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"] == stored


def _without(config, zid):
    """The setup with a zone removed, as the panel sends it: gone from the zones and from every device."""
    c = copy.deepcopy(config)
    c["zones"] = [z for z in c["zones"] if z["id"] != zid]
    for d in c["devices"]:
        d["zones"] = [z for z in d["zones"] if z != zid]
        d.get("place", {}).pop(zid, None)
    return c


def _share_veg_sensor(config):
    c = copy.deepcopy(config)
    nursery = next(z for z in c["zones"] if z["id"] == "nursery")
    nursery["sensors"].append(copy.deepcopy(next(z for z in c["zones"] if z["id"] == "veg")["sensors"][0]))
    return c


async def _save(client, revision, config):
    return await _send(client, type=f"{DOMAIN}/config/save", revision=revision, config=config)


@pytest.mark.parametrize("sent_linked", [True, False])
async def test_removing_a_parent_unlinks_its_linked_zones(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked, sent_linked
) -> None:
    """Whether or not the panel unlinked it already, the linked zone stays and is stored with no parent."""
    room = {"zones": sample_unlinked["zones"], "devices": sample_unlinked["devices"]}
    client = await hass_ws_client(hass)
    assert (await _save(client, 0, room))["success"]
    c = _without(room, "veg")
    if not sent_linked:
        del c["zones"][-1]["parent"]
    r = await _save(client, 1, c)
    assert r["success"], r
    await hass.async_block_till_done()
    stored = hass_storage[DOMAIN]["data"]
    assert [z["id"] for z in stored["zones"]] == ["garden", "nursery"]
    assert all("parent" not in z for z in stored["zones"]) and all("parent" not in z for z in r["result"]["zones"])


async def test_removing_a_parent_a_linked_zone_shares_a_sensor_with_is_refused(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    room = _share_veg_sensor({"zones": sample_unlinked["zones"], "devices": sample_unlinked["devices"]})
    client = await hass_ws_client(hass)
    assert (await _save(client, 0, room))["success"]
    await hass.async_block_till_done()
    before = copy.deepcopy(hass_storage[DOMAIN]["data"])
    r = await _save(client, 1, _without(room, "veg"))
    assert not r["success"] and r["error"]["code"] == "invalid_config"
    assert (
        r["error"]["message"]
        == "Veg environment is in both Veg and Nursery. Take it out of Nursery before removing Veg."
    )
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"] == before


async def test_a_parent_no_setup_ever_had_is_refused_while_a_zone_is_removed(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    room = {"zones": sample_unlinked["zones"], "devices": sample_unlinked["devices"]}
    client = await hass_ws_client(hass)
    assert (await _save(client, 0, room))["success"]
    c = _without(room, "veg")
    c["zones"][-1]["parent"] = "attic"
    r = await _save(client, 1, c)
    assert not r["success"] and r["error"]["message"] == "nursery is linked to a zone that doesn't exist"


async def test_unlinking_goes_by_the_stored_setup(hass, loaded, hass_ws_client, hass_storage, sample_unlinked) -> None:
    """A zone stops sharing a sensor by taking it out first, then it can be unlinked."""
    room = _share_veg_sensor({"zones": sample_unlinked["zones"], "devices": sample_unlinked["devices"]})
    client = await hass_ws_client(hass)
    assert (await _save(client, 0, room))["success"]
    unlinked = copy.deepcopy(room)
    del unlinked["zones"][-1]["parent"]
    r = await _save(client, 1, unlinked)
    assert not r["success"]
    assert (
        r["error"]["message"]
        == "Veg environment is in both Veg and Nursery. Take it out of Nursery before unlinking it."
    )
    unlinked["zones"][-1]["sensors"].pop()
    assert (await _save(client, 1, unlinked))["success"]
    await hass.async_block_till_done()
    assert "parent" not in hass_storage[DOMAIN]["data"]["zones"][-1]


async def _load_stored(hass, hass_storage, stored):
    hass_storage[DOMAIN] = {"version": 1, "minor_version": 1, "key": DOMAIN, "data": copy.deepcopy(stored)}
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def test_a_setup_stored_before_linked_zones_loads_and_saves_as_before(
    hass, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    zones = copy.deepcopy(sample_unlinked["zones"])
    for z in zones:
        z.pop("parent", None)
    stored = {"revision": 4, "zones": zones, "devices": sample_unlinked["devices"]}
    await _load_stored(hass, hass_storage, stored)
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["success"] and r["result"] == stored
    r = await _save(client, 4, {"zones": zones, "devices": sample_unlinked["devices"]})
    assert r["success"] and r["result"] == {**stored, "revision": 5}
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"] == {**stored, "revision": 5}


async def test_a_setup_stored_with_a_sensor_in_two_unlinked_zones_loads_and_cannot_be_saved_as_it_is(
    hass, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    """Pins today's behaviour: before linked zones any two zones could share a sensor, and there is no migration. The
    panel shows the setup, and a save asks for the sensor to come out of one zone or the zones to be linked."""
    room = _share_veg_sensor({"zones": sample_unlinked["zones"], "devices": sample_unlinked["devices"]})
    for z in room["zones"]:
        z.pop("parent", None)
    stored = {"revision": 4, **room}
    await _load_stored(hass, hass_storage, stored)
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["success"] and r["result"] == stored
    r = await _save(client, 4, room)
    assert (
        not r["success"]
        and r["error"]["message"] == "A sensor can only be shared between a zone and the zones linked to it."
    )
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"] == stored


async def test_two_saves_at_one_revision_keep_one_and_refuse_the_other(hass, hass_storage) -> None:
    store = ConfigStore(hass)
    await store.async_load()
    write = store._store.async_save

    async def write_off_the_loop(data):
        await asyncio.sleep(0)  # HA writes the file in an executor, so the loop runs other work meanwhile
        await write(data)

    store._store.async_save = write_off_the_loop
    first = {"zones": [{"id": "a", "name": "A"}], "devices": []}
    second = {"zones": [{"id": "b", "name": "B"}], "devices": []}
    results = await asyncio.gather(store.async_save(0, first), store.async_save(0, second), return_exceptions=True)
    assert results[0] == {**first, "revision": 1}
    assert isinstance(results[1], RevisionConflict)
    assert store.data == {**first, "revision": 1}
