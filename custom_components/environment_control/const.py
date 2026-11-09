"""Constants for Environment Control."""

DOMAIN = "environment_control"
PANEL_URL_PATH = "environment-control"
PANEL_ELEMENT = "environment-control-panel"
PANEL_TITLE = "Environment Control"
PANEL_ICON = "mdi:sprout"
STATIC_URL = f"/{DOMAIN}_static"

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

# The host refuses anything larger before it reaches here; this is the backend's own limit.
MAX_CONFIG_BYTES = 512 * 1024
MAX_ZONES = 20
MAX_DEVICES = 200

# The catalog Setup picks from. A home has tens of devices and around a thousand entities; the caps keep a huge
# install's answer to a size a phone can take.
MAX_CATALOG_DEVICES = 1000
MAX_CATALOG_ENTITIES = 5000
