"""Chart history bucketed by the live readings' rules: dead and stale readings break the line."""

import pytest

from custom_components.environment_control.history import bucket, mapped_readings


def test_each_bucket_keeps_its_mean_and_its_own_low_and_high() -> None:
    # 10 second readings over two 60 second buckets, with a spike in the second.
    rows = [(float(t), 20 + (t // 10) % 2) for t in range(0, 120, 10)]
    rows[9] = (90.0, 30)
    a, b = bucket(rows, 0, 120, 2)
    assert a == [20.5, 20, 21]
    assert b[1:] == [20, 30]
    assert b[0] == pytest.approx((20 + 21 + 20 + 30 + 20 + 21) / 6, abs=1e-3)


def test_a_reading_that_is_not_a_number_breaks_the_line() -> None:
    rows = [(0.0, "20"), (60.0, "unavailable"), (120.0, "unknown"), (180.0, "22")]
    assert bucket(rows, 0, 240, 4) == [[20.0, 20.0, 20.0], None, None, [22.0, 22.0, 22.0]]


def test_a_reading_counts_for_ten_minutes_at_most() -> None:
    # A board that stops reporting while it stays connected: its last reading doesn't run on.
    out = bucket([(0.0, "20")], 0, 3600, 6)
    assert out[0] == [20.0, 20.0, 20.0]
    assert out[1:] == [None] * 5


def test_the_mean_is_weighted_by_how_long_each_reading_held() -> None:
    [[mean, lo, hi]] = bucket([(0.0, "10"), (50.0, "20")], 0, 60, 1)
    assert (round(mean, 3), lo, hi) == (11.667, 10, 20)


def test_the_reading_in_force_at_the_start_carries_into_the_window() -> None:
    assert bucket([(-30.0, "18"), (60.0, "19")], 0, 120, 2) == [[18.0, 18.0, 18.0], [19.0, 19.0, 19.0]]


def test_only_a_sensor_s_mapped_readings_count_as_mapped() -> None:
    config = {
        "zones": [
            {
                "id": "g",
                "sensors": [
                    {"id": "s", "entities": {"temperature": "sensor.t", "vpd": "sensor.v"}, "leafEntity": "number.o"}
                ],
            }
        ],
        "devices": [{"id": "d", "entity": "switch.heater", "zones": ["g"]}],
    }
    assert mapped_readings(config) == {"sensor.t", "sensor.v"}
