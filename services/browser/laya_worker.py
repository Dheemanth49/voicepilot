"""Persistent JSONL worker for VoicePilot's optional Laya browser runtime."""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from typing import Any
from urllib.parse import urlsplit


def _run(request: Any, decider: Any, driver_type: Any, active_values: dict[str, str], endpoint: str, target_url_contains: str) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("Each worker request must be a JSON object.")
    goal = request.get("goal")
    start_url = request.get("start_url")
    values = request.get("text_values", {})
    if not isinstance(goal, str) or not goal.strip() or len(goal) > 2000:
        raise ValueError("goal must be a non-empty string of at most 2,000 characters.")
    if not isinstance(start_url, str):
        raise ValueError("start_url must be an explicit http or https URL.")
    parsed_url = urlsplit(start_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname:
        raise ValueError("start_url must be an explicit http or https URL with a host.")
    if not isinstance(values, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in values.items()):
        raise ValueError("text_values must map element labels to explicit text strings.")
    if len(values) > 30 or any(len(key) > 200 or len(value) > 2000 for key, value in values.items()):
        raise ValueError("text_values exceeds the supported bounds.")

    active_values.clear()
    active_values.update({key.strip().casefold(): value for key, value in values.items()})
    driver = driver_type(endpoint=endpoint, target_url_contains=target_url_contains)
    try:
        # CDPDriver attaches to a page in the user's browser. Navigate that page to
        # the exact destination authorized by the bridge before asking Laya to act.
        driver._call("Page.navigate", url=start_url)
        time.sleep(1)
        run = decider.run(driver, goal.strip())
    finally:
        driver.close()
    summary = run.summary()
    return {
        "ok": bool(run.solved),
        "solved": bool(run.solved),
        "stopped": str(run.stopped),
        "summary": summary,
        "steps": [
            {
                "number": step.n,
                "operation": str(step.operation),
                "label": str(step.label),
                "confidence": float(step.confidence),
            }
            for step in run.steps
        ],
    }


def main() -> int:
    try:
        from localdecide import BrowserDecider
        from localdecide.drivers import CDPDriver
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"Laya runtime is unavailable: {error}"}), flush=True)
        return 2

    # Reuse the decider/model while refreshing only the per-task typing values.
    active_values: dict[str, str] = {}
    def provider(_goal: str, element: Any) -> str:
        label = str(getattr(element, "label", "")).strip().casefold()
        if label not in active_values:
            raise ValueError(f"No user-provided text value was supplied for the field '{label}'.")
        return active_values[label]

    decider = BrowserDecider(text_provider=provider, max_steps=12)
    endpoint = os.environ.get("VOICEPILOT_BROWSER_CDP_ENDPOINT", "http://127.0.0.1:9222").rstrip("/")
    target_url_contains = os.environ.get("VOICEPILOT_BROWSER_TARGET_URL_CONTAINS", "")
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = _run(request, decider, CDPDriver, active_values, endpoint, target_url_contains)
        except Exception as error:
            response = {"ok": False, "error": str(error), "trace": traceback.format_exc(limit=3)}
        print(json.dumps(response, ensure_ascii=False, default=str), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
