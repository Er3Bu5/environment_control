"""The frontend's npm audit gate: one advisory can be set aside, by id and until a date, and nothing else can."""

import datetime
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "check_npm_audit", Path(__file__).parents[1] / "scripts" / "check_npm_audit.py"
)
assert _spec and _spec.loader
check_npm_audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_npm_audit)

TODAY = datetime.date(2026, 11, 18)
IGNORED = {"GHSA-aaaa-bbbb-cccc": {"package": "picomatch", "review_by": "2027-02-18"}}


def _advisory(ghsa, name, severity):
    return {
        "source": 1,
        "name": name,
        "title": "a bug",
        "url": f"https://github.com/advisories/{ghsa}",
        "severity": severity,
        "range": "<=1.0.0",
    }


def _report(*advisories):
    """Shaped like npm 11's audit --json: the advisory on its own package, and a dependent naming that package."""
    vulnerabilities = {a["name"]: {"severity": a["severity"], "via": [a]} for a in advisories}
    vulnerabilities["vitest"] = {"severity": "high", "via": [a["name"] for a in advisories]}
    return {"auditReportVersion": 2, "vulnerabilities": vulnerabilities}


def test_an_ignored_advisory_passes_before_its_review_date():
    report = _report(_advisory("GHSA-aaaa-bbbb-cccc", "picomatch", "high"))
    assert check_npm_audit.problems(report, IGNORED, TODAY) == []


def test_an_ignored_advisory_fails_once_its_review_date_has_passed():
    report = _report(_advisory("GHSA-aaaa-bbbb-cccc", "picomatch", "high"))
    [problem] = check_npm_audit.problems(report, IGNORED, datetime.date(2027, 2, 19))
    assert "look at it again" in problem


def test_any_other_advisory_of_moderate_or_above_fails():
    report = _report(
        _advisory("GHSA-aaaa-bbbb-cccc", "picomatch", "high"),
        _advisory("GHSA-dddd-eeee-ffff", "lit", "moderate"),
    )
    [problem] = check_npm_audit.problems(report, IGNORED, TODAY)
    assert "lit" in problem and "GHSA-dddd-eeee-ffff" in problem


def test_a_low_advisory_passes_as_npm_audit_level_moderate_did():
    report = _report(
        _advisory("GHSA-aaaa-bbbb-cccc", "picomatch", "high"),
        _advisory("GHSA-1111-2222-3333", "x", "low"),
    )
    assert check_npm_audit.problems(report, IGNORED, TODAY) == []


def test_an_ignored_advisory_no_longer_reported_fails_so_the_entry_is_removed():
    [problem] = check_npm_audit.problems(_report(), IGNORED, TODAY)
    assert "remove it from IGNORED" in problem


def test_an_npm_error_fails():
    [problem] = check_npm_audit.problems({"error": {"code": "ENOLOCK"}}, {}, TODAY)
    assert "npm audit failed" in problem


def test_every_real_entry_names_a_package_and_a_review_date():
    for ghsa, entry in check_npm_audit.IGNORED.items():
        assert ghsa.startswith("GHSA-")
        assert entry["package"]
        datetime.date.fromisoformat(entry["review_by"])
