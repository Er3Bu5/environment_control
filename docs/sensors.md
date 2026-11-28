# Sensors for Environment Control

Environment Control judges a reading stale when Home Assistant hasn't updated it for ten minutes, so
every environment sensor in a zone must send each reading at a fixed interval, changed or not. This
page is a complete ESPHome config that does that, for the reference hardware: a PoE ESP32 board
(an M5Stack PoESP32 here) with an SHT3x temperature and humidity sensor, a QMP6988 pressure sensor
and a BH1750 light sensor on I2C. Change the board, the Ethernet block and the I2C pins to match
yours. The sensor settings are the part that matters.

## What each setting is for

- `update_interval: 10s` and `force_update: true` on every sensor: a reading every ten seconds,
  sent to Home Assistant even when it hasn't changed. Without `force_update` a steady room looks
  dead to the panel.
- `timeout: 21s`, last in each sensor's filters: if a read stalls while the board stays connected,
  the sensor publishes unknown after about two missed polls instead of holding its last value. It
  has to come after `filter_out: nan`, or that filter drops the unknown it sends.
- The `Leaf Temperature Offset` number: the panel sets a sensor's leaf temperature offset by writing
  this number, which must be in °C and on the same device as the sensor. `restore_value` keeps it
  through a reboot.
- The `VPD` sensor: worked out on the board from air temperature, humidity and the leaf offset.
- Pressure isn't used by the panel. Leave it out if your board has no pressure sensor.
- `state_class` isn't needed: the panel's History reads Home Assistant's recorded states, not its
  long-term statistics.

## Example

Put your own values in `secrets.yaml` for `api_encryption_key` and `ota_password`.

```yaml
esphome:
  name: tent-environment
  friendly_name: "Tent Environment"

esp32:
  board: m5stack-core-esp32
  framework:
    type: esp-idf

logger:

api:
  encryption:
    key: !secret api_encryption_key

ota:
  - platform: esphome
    password: !secret ota_password

ethernet:
  type: IP101
  mdc_pin: GPIO23
  mdio_pin: GPIO18
  phy_addr: 1
  power_pin:
    number: GPIO5
    ignore_strapping_warning: true
  clk:
    pin:
      number: GPIO0
      ignore_strapping_warning: true
    mode: CLK_EXT_IN

i2c:
  sda: 16
  scl: 17

number:
  - platform: template
    name: "Leaf Temperature Offset"
    id: leaf_temp_offset
    unit_of_measurement: "°C"
    min_value: -5
    max_value: 2
    step: 0.1
    initial_value: -1
    optimistic: true
    restore_value: true

sensor:
  - platform: sht3xd
    address: 0x44
    update_interval: 10s
    temperature:
      name: "Air Temp"
      id: air_temp
      force_update: true
      filters:
        - timeout: 21s
    humidity:
      name: "Humidity"
      id: humidity
      force_update: true
      filters:
        - timeout: 21s

  - platform: qmp6988
    address: 0x70
    update_interval: 10s
    pressure:
      name: "Pressure"
      force_update: true
      filters:
        - timeout: 21s

  - platform: bh1750
    name: "Light"
    address: 0x23
    update_interval: 10s
    force_update: true
    filters:
      - timeout: 21s

  - platform: template
    name: "VPD"
    unit_of_measurement: kPa
    accuracy_decimals: 2
    update_interval: 10s
    force_update: true
    filters:
      - filter_out: nan
      - timeout: 21s
    lambda: |-
      float t_air = id(air_temp).state;
      float t_leaf = t_air + id(leaf_temp_offset).state;
      float svp_leaf = 0.6108f * expf((17.27f * t_leaf) / (t_leaf + 237.3f));
      float avp = (id(humidity).state / 100.0f) * 0.6108f * expf((17.27f * t_air) / (t_air + 237.3f));
      return svp_leaf - avp;
```
