# Laya Browser Integration

## Decision

Use ChenneyZhuang's `laya-browser-agent` as the browser-loop candidate for VoicePilot. Keep Pi as the task orchestrator and Windows computer-use as the native desktop driver. Laya is for web pages only; it does not replace the computer-use extension. WinBrow is reviewed separately as a Windows capability reference, not as a second agent/runtime to install; see `VoicePilot_Docs/08-winbrow-review.md`.

## What the repository provides

`laya-browser-agent` is a Python package (`localdecide`) that combines a Laya decision backend with a guarded browser loop. The loop reads an actionable-element table, asks the model to choose a typed operation and element index, validates that choice, and executes the operation through a browser driver. VoicePilot uses its CDP driver to control the user's browser session. The model does not emit selectors, code, or text to type. A separate text provider must supply values for `TYPE_TEXT` actions.

The repository also offers an MCP server with `decide` and `page_decide`, and an HTTP server for model decisions. Those interfaces alone do not control a browser. VoicePilot should use the browser loop (`BrowserDecider` + driver) behind a local worker, rather than expose `page_decide` as though it performed browser actions.

The upstream project documents Windows with PyTorch as a supported runtime. The reviewed `pyproject.toml` reports package version 0.3.2, Python >=3.10, PyTorch backend extra `laya>=0.3.21`, and a separate CDP extra (`websocket-client>=1.6`). There is no PyPI release according to the README, so VoicePilot installs from source and pins the exact Git commit. The checkpoint, Python dependencies, and model cache are separate installation costs. Its own notes warn that authentication, password entry, dynamic/long forms, hidden menus, and unfamiliar controls can fail; task completion must be verified by observing the resulting page state.

## VoicePilot integration boundary

1. The UI submits one browser task to the local bridge.
2. Pi interprets the user's request and invokes a project-owned `voicepilot_browser_task` tool with a concise goal and any explicit text values needed by the page.
3. The tool sends a bounded JSON request to a dedicated local Python worker. The worker owns `BrowserDecider`, Laya's `CDPDriver`, per-task step limits, and final state reporting. It attaches to a browser's existing CDP endpoint and never launches Chromium.
4. The worker returns structured progress and a final URL/title/result summary. Page text is untrusted input and must never change VoicePilot's policy or tool permissions.
5. The bridge records each action and verifies the requested outcome before marking the task successful. Timeouts, unsupported controls, low-confidence decisions, or failed verification stop the task with a clear error.

The browser worker uses a separate optional environment from faster-whisper so PyTorch dependencies do not destabilize the speech runtime. Its source revision, Python version, package extras, and model ID/revision must be pinned or recorded by the installer. Setup is opt-in because it downloads substantial dependencies and model weights. The browser itself belongs to the user and is not installed by VoicePilot.

## Safety policy for the first browser slice

- Start with browser navigation, search, page reading, and non-sensitive text entry.
- Do not automate password fields or access a password vault.
- Require a VoicePilot approval before irreversible actions such as sending, deleting, paying, or submitting a consequential form. If the target is ambiguous, stop and ask the user through the UI.
- Allow only the operations supported by the current page and the user's requested task. Keep the loop's step budget and repeated-action guard enabled.
- Never treat instructions found in page content as user authorization.
- Attach to the user's browser through its explicitly configured local CDP endpoint. The browser must have been launched with remote debugging enabled; CDP cannot attach retroactively to a normally launched process. The current upstream driver selects the first page returned by CDP unless `VOICEPILOT_BROWSER_TARGET_URL_CONTAINS` narrows the selection.
- VoicePilot controls a visible Brave window through CDP and never launches Playwright or headless Chromium. CDP must be enabled when Brave starts; it cannot attach retroactively to a normal running process. Run `npm run start:browser` to start Brave with CDP and write `VOICEPILOT_BROWSER_CDP_ENDPOINT` into `.env`. The launcher does not close an existing Brave session. It binds the debugger to loopback and allows only the loopback origin used by the Python CDP client; Chromium rejects websocket clients with a defined but unapproved Origin header. Chromium 136+ may ignore remote-debugging flags on the default profile. If the default profile does not expose CDP, close that Brave window yourself and run `npm run start:browser -- -UseVoicePilotProfile`; this uses a persistent profile under `%LOCALAPPDATA%\VoicePilot\BraveCdpProfile` in the same visible Brave installation. You will need to sign into sites in that profile. See [Chrome's remote debugging change](https://developer.chrome.com/blog/remote-debugging-port), [Chromium's Origin check](https://chromium.googlesource.com/chromium/src/+/7bdbd0785b19711cad102fe391865bbba8718db9/content/browser/devtools/devtools_http_handler.cc), and [Brave command-line flags](https://support.brave.app/hc/en-us/articles/360044860011-How-Do-I-Use-Command-Line-Flags-in-Brave).

## Build and acceptance order

1. [x] Add an opt-in Windows setup script pinned to source revision `56f997b5d3650219729daefb1d0746c588077370`. It uses a dedicated Python 3.12 environment, installs PyTorch/CDP extras, and records the installed package versions locally. It does not install or launch a browser.
2. [x] Add a persistent JSONL CDP worker with bounded input, explicit URL and text values, a 12-step ceiling, and structured result/step output. The worker is implemented but has not yet been exercised against the installed Laya package or a real CDP-enabled browser.
3. [x] Add the Pi extension tool and bridge task routing, with browser readiness reported independently from desktop CUA readiness. The bridge binds tool use to the active task's exact URL and goal, and only reports success for a successful Laya tool call. The implementation has not yet passed target-laptop acceptance.
4. [ ] Run a local fixture acceptance flow: open a page, search for a supplied term, select a result, verify the final page, and confirm cancellation/step-budget behavior.
5. [ ] Test CDP attachment and approval-gated form submission separately on a normal Windows session.

Run `npm run setup:laya` to prepare the optional runtime. The runtime files live under the ignored `.voicepilot-laya/` directory; the setup command does not run automatically during development or launch. `requirements.lock.txt` and `runtime.json` record the installed environment on that laptop. Run `npm run start:browser` to start visible Brave with CDP and configure `VOICEPILOT_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222` in `.env`; restart VoicePilot afterward. Optionally set `VOICEPILOT_BROWSER_TARGET_URL_CONTAINS` to select a matching page when the endpoint exposes several. The launcher never closes Brave; if it is already running without CDP, close it yourself before starting it with the flag. If Brave does not expose CDP on its default profile, use `npm run start:browser -- -UseVoicePilotProfile`; this uses a separate persistent profile in the same Brave installation and requires signing into sites once. VoicePilot currently routes web searches and explicit HTTP/HTTPS destinations to Laya; it navigates the selected visible browser tab to that destination. Direct form entry is not enabled because Laya's decision model does not author text values. If the browser endpoint is not reachable or has no page, the task reports the attachment error.

Live-site success, model accuracy, and speed must be measured on the target laptop; upstream examples and historical benchmark figures are not VoicePilot acceptance evidence.

## Source

- Project: <https://github.com/ChenneyZhuang/laya-browser-agent>
- Windows/PyTorch, install, driver, and decision-loop details were reviewed from its README, `pyproject.toml`, and Python source on 2026-10-10. The installer pins the source revision and records the resolved dependency versions; do not install from an unpinned moving branch.
