"""Require named GitHub checks from the current ready-for-review phase."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone


def timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def check_name(item: dict) -> str:
    return str(item.get("name") or item.get("context") or "")


def result(item: dict) -> str:
    if item.get("__typename") == "CheckRun":
        if item.get("status") != "COMPLETED":
            return "pending"
        return "success" if item.get("conclusion") == "SUCCESS" else "failed"
    state = item.get("state")
    if state in ("PENDING", "EXPECTED", None):
        return "pending"
    return "success" if state == "SUCCESS" else "failed"


def fingerprint(item: dict) -> tuple:
    return (
        item.get("__typename"),
        check_name(item),
        item.get("startedAt"),
        item.get("detailsUrl") or item.get("targetUrl"),
        item.get("status"),
        item.get("conclusion") or item.get("state"),
    )


def classify(
    payload: dict,
    required: list[str],
    ready_after: datetime,
    expected_head: str,
    pre_ready: list[dict] | None = None,
) -> dict:
    if payload.get("isDraft") is not False:
        raise ValueError("the pull request is still draft")
    if payload.get("headRefOid") != expected_head:
        raise ValueError(
            f"the pull request head changed: expected {expected_head}, found {payload.get('headRefOid')}"
        )

    rows = payload.get("statusCheckRollup")
    if not isinstance(rows, list):
        raise ValueError("GitHub returned no statusCheckRollup array")

    pending: list[str] = []
    failed: list[str] = []
    passed: list[str] = []
    prior = {fingerprint(item) for item in (pre_ready or []) if isinstance(item, dict)}
    for name in required:
        fresh = []
        for item in rows:
            if not isinstance(item, dict) or check_name(item) != name:
                continue
            started = item.get("startedAt")
            if (
                isinstance(started, str)
                and timestamp(started) >= ready_after
                and fingerprint(item) not in prior
            ):
                fresh.append(item)
        if not fresh:
            pending.append(f"{name} (no run started after ready)")
            continue
        newest = max(fresh, key=lambda item: timestamp(item["startedAt"]))
        state = result(newest)
        if state == "success":
            passed.append(name)
        elif state == "pending":
            pending.append(f"{name} (running)")
        else:
            failed.append(
                f"{name} ({newest.get('conclusion') or newest.get('state') or 'unknown'})"
            )

    if failed:
        raise ValueError("required post-ready check failed: " + ", ".join(failed))
    if pending:
        return {"state": "pending", "detail": ", ".join(pending)}
    return {"state": "concluded", "detail": f"post-ready checks passed: {', '.join(passed)}"}


def main() -> int:
    required = [
        name.strip()
        for name in os.environ.get("INPUTS_REQUIRED_CHECKS", "").split(",")
        if name.strip()
    ]
    if not required:
        print(json.dumps({"state": "concluded", "detail": "no post-ready checks required"}))
        return 0
    if len(required) != len(set(required)):
        print("check-post-ready: required check names must be unique", file=sys.stderr)
        return 1

    marker_path = os.environ.get("INPUTS_MARKER", "")
    try:
        with open(marker_path, encoding="utf-8") as handle:
            marker = json.load(handle)
        ready_after = timestamp(marker["ready_after"])
        marker_head = marker["head"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"check-post-ready: invalid ready marker: {error}", file=sys.stderr)
        return 1

    expected_head = str(marker_head)
    try:
        with open(os.environ.get("INPUTS_PRE_READY_CHECKS", ""), encoding="utf-8") as handle:
            pre_ready_payload = json.load(handle)
        pre_ready = pre_ready_payload["statusCheckRollup"]
        if not isinstance(pre_ready, list):
            raise ValueError("statusCheckRollup is not an array")
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"check-post-ready: invalid pre-ready check snapshot: {error}", file=sys.stderr)
        return 1

    proc = subprocess.run(
        [
            "gh", "pr", "view", os.environ["INPUTS_PR_NUMBER"],
            "--repo", os.environ["INPUTS_REPO"],
            "--json", "isDraft,headRefOid,statusCheckRollup",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(f"check-post-ready: could not read the pull request: {proc.stderr.strip()}", file=sys.stderr)
        return 1
    try:
        payload = json.loads(proc.stdout)
        verdict = classify(payload, required, ready_after, expected_head, pre_ready)
    except (json.JSONDecodeError, ValueError) as error:
        print(f"check-post-ready: {error}", file=sys.stderr)
        return 1
    print(json.dumps(verdict))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
