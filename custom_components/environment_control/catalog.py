"""What Home Assistant has, for the panel's setup: devices, their entities, and how each device is connected.

Read only, from HA's registries and states. Only names, areas, entity ids, domains, device classes, units, states and
the detected connection leave this module. Identifiers, connection values (MACs), serial numbers, configuration URLs
(which often hold an address), firmware versions and config-entry data never do.

How a device is connected is detected, never guessed: anything the registries can't tell is "unknown", and Setup asks.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.loader import async_get_integrations

from .const import MAX_CATALOG_DEVICES, MAX_CATALOG_ENTITIES

# The domains setup can use: readings and settings from sensors, and the things a zone switches, dims or detects day by.
DOMAINS = frozenset(
    {"binary_sensor", "climate", "fan", "humidifier", "input_boolean", "light", "number", "sensor", "switch"}
)

# Integrations whose devices all use one link. Extended as needed; anything else falls to the evidence below.
PLATFORM_LINK = {"tuya_local": "wifi", "shelly": "wifi", "zha": "zigbee", "deconz": "zigbee", "zwave_js": "zwave"}
# Integrations that make things up from other things, so their entities are derived rather than devices.
DERIVED_PLATFORMS = frozenset({"template", "group", "derivative", "min_max", "statistics", "filter", "utility_meter"})


@dataclass(frozen=True)
class Link:
    """How a device reaches Home Assistant: its link, and whether it goes through the cloud."""

    link: str  # ethernet, wifi, zigbee, zwave, thread, bluetooth, derived or unknown
    path: str  # local, cloud, derived or unknown


def classify(
    *,
    platform: str | None,
    connection_types: frozenset[str],
    has_hub: bool,
    iot_class: str | None,
    service: bool,
) -> Link:
    """Detect a device's link and path from registry evidence alone. What can't be told is unknown."""
    if service or (platform in DERIVED_PLATFORMS) or (platform or "").startswith("input_"):
        return Link("derived", "derived")

    if platform in PLATFORM_LINK:
        link = PLATFORM_LINK[platform]
    elif "zigbee" in connection_types and has_hub:
        # A zigbee address on a device behind a hub. The hub itself also carries one, and says nothing of its own link.
        link = "zigbee"
    elif "bluetooth" in connection_types:
        link = "bluetooth"
    else:
        # ESPHome boards show only a MAC, which a wired board and a WiFi board both have.
        link = "unknown"

    if iot_class and iot_class.startswith("local"):
        path = "local"
    elif iot_class and iot_class.startswith("cloud"):
        path = "cloud"
    else:
        path = "unknown"
    return Link(link, path)


def _area_name(areas: ar.AreaRegistry, area_id: str | None) -> str | None:
    area = areas.async_get_area(area_id) if area_id else None
    return area.name if area else None


def _entity(hass: HomeAssistant, entry: er.RegistryEntry, areas: ar.AreaRegistry) -> dict[str, Any]:
    state = hass.states.get(entry.entity_id)
    attrs = state.attributes if state else {}
    out = {
        "entity_id": entry.entity_id,
        "name": attrs.get("friendly_name") or entry.name or entry.original_name or entry.entity_id,
        "domain": entry.domain,
        "device_class": attrs.get("device_class") or entry.device_class or entry.original_device_class,
        "unit": attrs.get("unit_of_measurement") or entry.unit_of_measurement,
        "state": state.state if state else None,
        "category": entry.entity_category.value if entry.entity_category else None,
        "area": _area_name(areas, entry.area_id),
    }
    # A number's own limits, so Sensor Calibration can hold a value to them before the number is linked.
    if entry.domain == "number":
        for k in ("min", "max", "step"):
            v = attrs.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                out[k] = v
    return out


async def async_build_catalog(hass: HomeAssistant) -> dict[str, Any]:
    """Every enabled device with an entity setup can use, then entities that belong to no device."""
    devices, entities, areas = dr.async_get(hass), er.async_get(hass), ar.async_get(hass)

    usable: dict[str, list[er.RegistryEntry]] = {}
    loose: list[er.RegistryEntry] = []
    for entry in entities.entities.values():
        if entry.disabled_by or entry.domain not in DOMAINS:
            continue
        if entry.device_id:
            usable.setdefault(entry.device_id, []).append(entry)
        else:
            loose.append(entry)

    # The integration that made most of a device's entities is the one it belongs to.
    platform_of = {
        device_id: Counter(e.platform for e in found).most_common(1)[0][0] for device_id, found in usable.items()
    }
    platforms = set(platform_of.values()) | {e.platform for e in loose}
    integrations = await async_get_integrations(hass, platforms)
    iot_class = {d: getattr(i, "iot_class", None) for d, i in integrations.items() if not isinstance(i, Exception)}
    family = {d: getattr(i, "name", d) for d, i in integrations.items() if not isinstance(i, Exception)}

    out_devices: list[dict[str, Any]] = []
    count = 0
    for device_id, found in usable.items():
        device = devices.async_get(device_id)
        if device is None or device.disabled_by:
            continue
        platform = platform_of[device_id]
        hub = devices.async_get(device.via_device_id) if device.via_device_id else None
        link = classify(
            platform=platform,
            connection_types=frozenset(kind for kind, _value in device.connections),
            has_hub=hub is not None,
            iot_class=iot_class.get(platform),
            service=device.entry_type is dr.DeviceEntryType.SERVICE,
        )
        found = sorted(found, key=lambda e: e.entity_id)[: MAX_CATALOG_ENTITIES - count]
        count += len(found)
        out_devices.append(
            {
                "id": device.id,
                "name": device.name_by_user or device.name or platform,
                "area": _area_name(areas, device.area_id),
                "manufacturer": device.manufacturer,
                "model": device.model,
                "integration": platform,
                "family": family.get(platform, platform),
                "link": link.link,
                "path": link.path,
                "hub": (hub.name_by_user or hub.name) if hub else None,
                "entities": [_entity(hass, e, areas) for e in found],
            }
        )
        if len(out_devices) >= MAX_CATALOG_DEVICES or count >= MAX_CATALOG_ENTITIES:
            break

    out_loose = [
        {**_entity(hass, e, areas), "integration": e.platform, "family": family.get(e.platform, e.platform)}
        for e in sorted(loose, key=lambda e: e.entity_id)[: max(0, MAX_CATALOG_ENTITIES - count)]
    ]
    out_devices.sort(key=lambda d: (d["area"] or "~", d["name"].lower()))
    return {"devices": out_devices, "entities": out_loose}
