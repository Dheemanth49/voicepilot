"""Persistent JSONL worker for VoicePilot's optional Laya browser runtime."""

from __future__ import annotations

import json
import os
import re
import secrets
import sys
import time
import traceback
from typing import Any
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


def _open_task_tab(endpoint: str) -> str:
    """Create a fresh visible browser tab and return a unique URL selector for it."""
    marker = f"voicepilot-task-{secrets.token_hex(12)}"
    blank_url = f"about:blank#{marker}"
    request = Request(f"{endpoint}/json/new?{quote(blank_url, safe='')}", method="PUT")
    try:
        with urlopen(request, timeout=5) as response:
            target = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        raise RuntimeError(f"Could not open a new browser tab over CDP: {error}") from error
    if not isinstance(target, dict) or target.get("type") != "page" or not isinstance(target.get("webSocketDebuggerUrl"), str):
        raise RuntimeError("The browser did not return a usable new tab from CDP.")
    return marker


def _run(request: Any, decider: Any, driver_type: Any, active_values: dict[str, str], endpoint: str) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("Each worker request must be a JSON object.")
    if request.get("type") == "route":
        text = request.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise ValueError("text must be a non-empty string of at most 2,000 characters.")
        from localdecide import choice
        decision = decider.decider.decide(text.strip(), {
            "route": choice(
                "Choose the single capability that should handle this request. Select chat for questions and conversation without computer actions; browser for web search or website interaction; desktop for Windows apps, windows, scrolling, or system controls; file_search for finding local files in approved folders.",
                {
                    "chat": "Answer a question or continue a conversation. Do not perform a computer action.",
                    "browser": "Search the web or open, inspect, or interact with a website.",
                    "desktop": "Launch or close a Windows app, scroll a window, or change system volume/audio.",
                    "file_search": "Search local files or documents in the user's approved folders.",
                },
            )
        })
        if not decision.ok or decision.answers is None:
            raise RuntimeError(f"Laya could not safely choose a route: {decision.error or 'no decision'}")
        return {
            "ok": True,
            "route": decision.answers.choice("route"),
            "confidence": decision.answers.confidence("route"),
            "backend": decision.answers.backend,
        }

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
    # Never attach a browser task to, or navigate over, a tab the user already
    # has open. Create a uniquely marked tab and let CDPDriver attach to it.
    task_tab_marker = _open_task_tab(endpoint)
    driver = driver_type(endpoint=endpoint, target_url_contains=task_tab_marker)
    try:
        # Navigate only the newly created task tab to the user-authorized URL.
        driver._call("Page.navigate", url=start_url)
        time.sleep(1)
        # A plain "open this URL" command is complete as soon as the requested
        # site is loaded. Asking the page-action model to click a control just to
        # confirm navigation can incorrectly turn this simple task into a failure.
        confirmation = re.fullmatch(r"Confirm that ([a-z0-9.-]+) has opened\.", goal.strip(), re.IGNORECASE)
        if confirmation:
            current_url = str(driver._eval("location.href") or "")
            expected_host = (urlsplit(start_url).hostname or confirmation.group(1)).casefold().removeprefix("www.")
            current_host = (urlsplit(current_url).hostname or "").casefold().removeprefix("www.")
            if current_host != expected_host and not current_host.endswith(f".{expected_host}"):
                raise RuntimeError(f"Navigation did not reach {expected_host}; the browser is at {current_url or 'an unknown URL'}.")
            return {
                "ok": True,
                "solved": True,
                "stopped": "done",
                "summary": {"goal": goal, "url": current_url, "solved": True, "stopped": "done", "steps": 1},
                "steps": [{"number": 1, "operation": "NAVIGATE", "label": current_url, "confidence": 1.0}],
            }
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
        from localdecide import BrowserDecider, Decider
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

    # Windows may need longer than Laya's 30-second default while the model is
    # loading or doing its first inference. Keep this under the bridge worker's
    # five-minute request timeout so the caller receives Laya's actual result.
    laya_decider = Decider(timeout=240)
    decider = BrowserDecider(decider=laya_decider, text_provider=provider, max_steps=12)
    endpoint = os.environ.get("VOICEPILOT_BROWSER_CDP_ENDPOINT", "http://127.0.0.1:9222").rstrip("/")
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = _run(request, decider, CDPDriver, active_values, endpoint)
        except Exception as error:
            response = {"ok": False, "error": str(error), "trace": traceback.format_exc(limit=3)}
        print(json.dumps(response, ensure_ascii=False, default=str), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
