# WinBrow Repository Review

Reviewed: 2026-10-10  
Repository: <https://github.com/leoantony72/laya-agent>  
Default branch observed: `main`

## Summary

WinBrow is a Windows 10/11 desktop-and-browser agent built around Laya routing. It has a useful breadth of built-in examples for volume/mute, themes, media keys, windows, Settings panes, app launch, files, and Chrome/Edge tasks. Its README also describes a dynamic PowerShell generator that executes and stores new scripts.

This is a useful feature reference for VoicePilot's remaining native-action backlog, but it should not be installed as a dependency or copied wholesale. VoicePilot already has a Pi RPC orchestration path, its own bridge/UI, request-bound approvals, and verified volume/app actions. Replacing those with a second server/agent would duplicate runtime and policy ownership.

## Integration choice

- Keep Pi RPC as VoicePilot's task orchestration path.
- Keep the earlier `laya-browser-agent` review as the browser loop candidate; it offers a discrete Playwright/CDP loop for browser-only tasks.
- Use WinBrow's built-in tool catalog as a discovery/reference list for future Windows actions. Reimplement individual actions behind VoicePilot's bridge and approvals, with exact input schemas, verification, cancellation, and tests.
- Do not enable dynamic PowerShell generation/execution in VoicePilot. A generated script is executable code with the current user's Windows permissions; a regex denylist cannot serve as an execution sandbox.

## Security and integration findings

1. `winbrow/generator.py` calls the model, constructs a PowerShell tool, runs `validate_script_safety`, and then calls `run_powershell` directly. On success it persists the generated tool to `tools/learned.json`. The inspected path does not put an explicit user approval between script generation and execution.
2. `winbrow/policy.py` uses regular-expression deny patterns for dangerous PowerShell commands. This can catch obvious strings but cannot establish that arbitrary PowerShell is safe; command aliases, indirection, encoded content, and calls through other APIs are broader than this textual policy.
3. The README advertises retrieval of the current Wi-Fi password and clipboard access. These capabilities expose secrets and should not be added without a separate explicit user action, visible disclosure, and a narrow permission path.
4. `winbrow/windows.py` runs PowerShell with `-ExecutionPolicy Bypass`. It runs under the current user's account and therefore inherits that account's accessible data and actions.
5. `winbrow/browser_task.py` exposes broad CDP browser control. CDP can act inside signed-in sessions; it needs a VoicePilot-owned approval and origin/task scope before consequential page actions.

These observations describe the reviewed source files, not a live security audit or verified behavior on a user laptop.

## Recommended capability order for VoicePilot

Add native actions one at a time after the current Pi/CUA acceptance boundary is verified:

1. Volume and mute read-back; app open/close with target verification.
2. Window management and media keys with clear active-window semantics.
3. Open Windows Settings panes and read-only system status.
4. File search constrained to configured user folders; require approval before move/delete.
5. Browser navigation/search through the dedicated browser worker.
6. No generated shell or PowerShell execution as a general fallback. An unsupported task should ask for a narrower request or return a supported-action explanation.

## Files reviewed

- `README.md`
- `server.py`
- `winbrow/agent.py`
- `winbrow/browser_task.py`
- `winbrow/generator.py`
- `winbrow/policy.py`
- `winbrow/registry.py`
- `winbrow/router.py`
- `winbrow/windows.py`

