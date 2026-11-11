"""The Beta workflow's version numbering and its test of whether a merge changed anything that ships."""

import importlib.util
import subprocess
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
        # Never a two-digit beta, which GitHub's release list doesn't sort as newest: after b9, the next patch's b1.
        (["v0.1.0b8", "v0.1.0b9"], "0.1.1b1"),
        # A b10 already out (2026-11-10) is read as newest, numerically, and also moves on to the next patch.
        (["v0.1.0b9", "v0.1.0b10", "v0.1.0b2"], "0.1.1b1"),
        (["v0.1.0b10", "v0.1.1b1"], "0.1.1b2"),
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


def _git(repo: Path, *args: str) -> str:
    cmd = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *args]
    return subprocess.run(cmd, cwd=repo, capture_output=True, text=True, check=True).stdout.strip()  # noqa: S603


def _merge(repo: Path, text: str) -> str:
    path = repo / "custom_components" / "environment_control" / "x.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", text)
    return _git(repo, "rev-parse", "HEAD")


def test_a_merge_a_newer_release_already_holds_makes_no_beta(tmp_path, monkeypatch, capsys) -> None:
    """Three merges queue up and the newest is released first: starting an older one again must not publish it."""
    _git(tmp_path, "init", "-q")
    first, second, third = (_merge(tmp_path, n) for n in ("one", "two", "three"))
    _git(tmp_path, "tag", "v0.1.2b2", first)
    monkeypatch.chdir(tmp_path)

    def outputs(commit: str) -> dict[str, str]:
        assert next_beta.main(["next_beta.py", commit]) == 0
        return dict(line.split("=", 1) for line in capsys.readouterr().out.splitlines())

    # In turn, each is ahead of the newest release and ships.
    assert outputs(second) == {"version": "0.1.2b3", "ship": "true", "since": "v0.1.2b2", "included": "false"}
    _git(tmp_path, "tag", "v0.1.2b3", third)
    # The release built from the third merge holds the second, and the third itself.
    assert outputs(second) == {"version": "0.1.2b4", "ship": "false", "since": "v0.1.2b3", "included": "true"}
    assert outputs(third) == {"version": "0.1.2b4", "ship": "false", "since": "v0.1.2b3", "included": "true"}
