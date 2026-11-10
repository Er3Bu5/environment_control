"""The Beta workflow's version numbering and its test of whether a merge changed anything that ships."""

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("next_beta", Path(__file__).parents[1] / "scripts" / "next_beta.py")
assert _spec and _spec.loader
next_beta = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(next_beta)


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        ([], "0.1.0b1"),
        (["v0.1.0b1", "v0.1.0b2"], "0.1.0b3"),
        # Numeric, not text: b10 is newer than b9.
        (["v0.1.0b9", "v0.1.0b10", "v0.1.0b2"], "0.1.0b11"),
        # A full release is newer than its own betas, so the next beta is of the next patch.
        (["v0.1.0b7", "v0.1.0"], "0.1.1b1"),
        # A beta of a newer version, started by hand, carries on.
        (["v0.1.0", "v0.2.0b1"], "0.2.0b2"),
        (["v0.1.0b3", "not-a-release", "v1"], "0.1.0b4"),
    ],
)
def test_the_next_beta_follows_the_newest_release(tags, expected) -> None:
    assert next_beta.next_beta(tags) == expected


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        (["custom_components/environment_control/catalog.py"], True),
        (["frontend/src/frame/main.ts", "README.md"], True),
        (["frontend/package-lock.json"], True),
        (["hacs.json"], True),
        (["README.md", "design/environment-control-source.html", "tests/test_setup.py"], False),
        ([".github/workflows/validate.yml", "frontend/test/e2e/panel.spec.ts", "scripts/check_privacy.py"], False),
        ([], False),
    ],
)
def test_only_a_change_to_what_ships_makes_a_beta(paths, expected) -> None:
    assert next_beta.ships(paths) is expected
