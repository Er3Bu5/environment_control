"""Which number entity a sensor's leaf temperature offset lives on: the backend's guard on the calibration write.

The panel's host writes a sensor's offset to the number entity the setup links it to, so the link decides what a
calibration can change. A compromised frame could otherwise save a link that points a calibration at some other
number entity. So a link a save adds or changes must be a number entity, on the same Home Assistant device as the
sensor's own readings (a sensor's id is its HA device id), in degrees Celsius. Links already stored stay as they are.
"""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .validation import InvalidConfig

CELSIUS = ("°C", "℃")


def _links(config: dict[str, Any]) -> dict[str, str]:
    """Each sensor's linked offset entity, by sensor id, where it is in use."""
    out: dict[str, str] = {}
    for z in config.get("zones") or []:
        for s in (z.get("sensors") or []) if isinstance(z, dict) else []:
            if isinstance(s, dict) and isinstance(s.get("leafEntity"), str) and not s.get("leafUnused"):
                out[str(s.get("id"))] = s["leafEntity"]
    return out


def check_leaf_links(hass: HomeAssistant, stored: dict[str, Any], config: dict[str, Any]) -> None:
    """Raise InvalidConfig for a new or changed offset link that isn't a °C number on the sensor's own device."""
    before, registry = _links(stored), er.async_get(hass)
    for sensor, entity in _links(config).items():
        if before.get(sensor) == entity:
            continue
        entry = registry.async_get(entity)
        if entry is None or entry.domain != "number":
            raise InvalidConfig(f"{entity} isn't a number entity in Home Assistant, so it can't hold an offset")
        if entry.device_id != sensor:
            raise InvalidConfig(f"{entity} isn't on the same device as that sensor's readings")
        state = hass.states.get(entity)
        unit = (state.attributes.get("unit_of_measurement") if state else None) or entry.unit_of_measurement
        if unit not in CELSIUS:
            raise InvalidConfig(f"{entity} isn't in °C, so it isn't a leaf temperature offset")
