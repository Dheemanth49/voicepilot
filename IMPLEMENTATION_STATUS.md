# VoicePilot implementation status

This checklist tracks implementation against `VoicePilot_Docs/06-implementation-plan.md`. A feature is complete only after its Windows acceptance check passes.

## Current verified slice

- [x] Optional Windows GPU acceleration is implemented for semantic search and faster-whisper speech: separate GPU Python environments, pinned CUDA/cuDNN runtimes, model smoke checks before settings activation, child-process-only DLL paths for speech, actual device reporting in health/UI, and read-only `npm run diagnose:gpu`. Full automated suite and production builds pass on 2026-10-11. The current execution environment cannot query the adapter (`nvidia-smi` unavailable and CIM access denied); GPU model/transcription acceptance on the user's RTX laptop remains outstanding.
- [x] Fixed the clean-laptop bootstrap path: `scripts/install-windows.ps1` now installs root bridge/UI packages with `npm ci` from `package-lock.json` before configuring Pi or optional local runtimes. Added installer regression coverage for ordering and for stopping cleanly when npm dependency installation fails. This verifies the bootstrap flow with mocked installers; an actual clean second-laptop installation remains outstanding.
- [x] Added `npm run package:windows`, which creates a clean source ZIP and SHA-256 sidecar under `.artifacts`. The generated archive contains 102 project files (~0.8 MB uncompressed), including installer scripts, package locks, Pi adapters, and baseline documents; validation confirms it excludes `.env`, model caches, virtual environments, and `node_modules`. A clean extraction succeeded. A real `npm ci` in the extracted copy was attempted but could not finish because this environment returned `ENOTFOUND registry.npmjs.org`; rerun dependency installation on a network-enabled Windows laptop.

- [x] React + Vite command screen and loopback-only Node bridge compile for production (`npm run build` passed against the current checkout).
- [x] Task policy accepts one simple application-launch request, rejects paths, shell apps, and compound/multi-action requests, and requires the launched app to match the user's request. Notepad is allowlisted; other app launches use a per-action approval gate.
- [x] Task history persistence, bridge health, and Pi RPC lifecycle are implemented.
- [x] Pi discovery prefers the project-pinned package and falls back to the managed Windows install; computer-use and KiloCode provider extensions are explicitly discovered and loaded while other extensions stay disabled. Pi installation/launch-argument tests cover this. Current user profile already has a KiloCode login; choose its model with `/model` in Pi.
- [x] Browser microphone recording and Alt+M while the VoicePilot page is focused are wired to the bridge's local STT endpoint.
- [x] Bridge audio endpoint limits uploads to 25 MB, permits a fixed set of audio MIME types, stores recordings temporarily, and removes them after transcription.
- [x] A persistent faster-whisper worker and Windows Python setup script are implemented; they are opt-in to avoid model downloads during startup.
- [x] The STT worker protocol has offline unit tests for successful transcription, malformed requests, and unsupported providers (4 passed).
- [x] Current launcher tests pass (3), bridge/Pi-gate tests pass (64), speech-worker tests pass (4), file-search tests pass (21), and bridge/UI production builds pass (`npm test`, `npm run build`, verified 2026-10-10). Bridge tests run with one Node test worker to avoid resource spikes on constrained Windows hosts.
- [x] One bounded vertical scroll can now be parsed, authorized against the exact active task and CUA arguments, routed through Pi, and reported only after a successful matching tool call. Unit tests and production TypeScript builds pass; visible scroll behavior still needs acceptance on the target Windows desktop.
- [x] Named app-window close is a dedicated Pi tool that lists visible windows, selects the frontmost matching app window, requests its normal `Alt+F4` close, and verifies that the window ID disappears. The bridge binds it to the app named in the active task; tests cover selection, successful close, and false-success prevention. Live Windows acceptance remains outstanding.
- [x] Task submission now persists and returns an executing task, exposes `GET /api/tasks/:taskId`, rejects concurrent work with `409 BUSY`, and the UI polls for terminal status. `POST /api/tasks/:taskId/cancel` requests Pi cancellation; a completed Notepad launch remains successful even if Pi subsequently reports an abort. Build checks pass; live HTTP acceptance is blocked by the local socket restrictions recorded below.
- [x] Persisted executing tasks are recovered as failed with a restart explanation; history remains capped at 50 and malformed records are discarded (3 history recovery tests pass).
- [x] The bridge pushes task-created, cancellation-requested, and task-finished WebSocket events to the configured UI origin and retains 100 events for reconnect; the UI listens and retains status polling as a fallback. Protocol utilities are tested and production builds pass, but a live socket handshake could not be verified in this environment.
- [x] `npm test` runs the bridge and speech worker suites together. The Windows speech setup now falls back from an unavailable Python Launcher registration to a validated `python.exe`, and the Windows bootstrap checks either installation path.
- [x] A Windows `RegisterHotKey` helper can notify the bridge; the UI polls the bridge to toggle browser recording.
- [x] Pi, speech, and Windows bootstrap scripts parse as PowerShell; the STT worker compiles as Python.
- [x] Pi health now distinguishes a running RPC process from a connected computer-use tool surface. Startup checks Pi's extension commands; the bridge marks CUA recovery mode as misconfigured and rejects desktop tasks until live tool discovery succeeds (2 new status tests pass).
- [x] Implemented the approved-folder semantic file-search slice: persistent SQLite folder/index metadata, text/PDF/DOCX extraction, EmbeddingGemma 2 query/document formatting, persistent Chroma retrieval, stale-file reconciliation, opaque short-lived result IDs, revalidated open-by-result, Settings UI, Python worker, and request-bound Pi tools. Fake-embedder/worker tests pass. On 2026-10-11 the user confirmed `npm run setup:file-search` completed and the real model loaded successfully. Search UI reports per-folder index counts and distinguishes no index, failed request, and no matches. Runtime logs exposed Windows OSError 1455; the loader now explicitly uses FP32 per user request and translates this error into a direct recovery message. Runtime memory acceptance remains.
- [x] Replaced VoicePilot's daemon-backed Pi CUA extension path with the project-owned direct-MCP adapter. The installed `cua-driver mcp --direct` process exposed 59 live tools; VoicePilot registered its 14-tool core surface, and a live Pi RPC startup reported `ready` with `desktopTools: available` in an isolated writable Pi profile. The Notepad launch action itself is still unverified in this execution environment.
- [x] `npm run setup:speech` installed faster-whisper 1.2.1 and its dependencies into `.venv`; a cached `small` model loads. A real audio decode exposed an upstream faster-whisper 1.2.1/PyAV 19 incompatibility, so setup now constrains PyAV to `<19`. The constrained dependency could not be installed in this sandbox because PyPI DNS is unavailable; the current `.venv` still has PyAV 19 and real transcription remains broken here until that downgrade is installed.
- [x] The Windows setup script can now be launched directly from PowerShell before Node.js is installed; its README flow explains the prerequisite-install rerun. Python Launcher errors are caught so setup can fall back to a registered `python.exe` instead of terminating early.
- [x] Pi's project-owned approval extension gates every mutating computer-use action, binds launch approvals to the exact user-requested app and tool call, consumes approvals once, and fails closed on rejection, expiry, cancellation, or bridge errors. UI approval prompts and WebSocket events are implemented; the hook/registry policy has unit coverage.
- [x] `npm run setup:pi` completed on this laptop: root and pinned Pi dependencies are installed, Pi reports 1.1.0, Git Bash is detected, and bundled computer-use settings are written. The setup script now skips redundant lockfile installs when required packages are already present and writes compatible UTF-8 settings for Windows PowerShell 5.1.
- [x] Windows prerequisite checks now validate that Python Launcher/`python.exe` resolves to a real interpreter, rather than trusting the Windows execution alias version string.

## Blocked on this machine

- [x] Pi CLI 1.1.0, computer-use 0.1.24 with the Windows CUA driver, and KiloCode provider 0.1.2 are present in the current Windows user's managed Pi install/package cache. The bridge now prefers a project-local Pi and falls back to the managed install, and explicitly loads the cached provider extensions.
- [ ] Verify a fresh dependency installation on another Windows laptop. npm and the pinned Pi/computer-use dependencies are installed in this checkout; `npm run setup:pi` now completes and reports Pi 1.1.0 plus Git Bash. A clean install/upgrade on another laptop remains unverified.
- [ ] Verify Pi RPC can open Notepad through computer-use. Direct MCP tool discovery and live Pi RPC startup now work; the remaining acceptance needs a successful `launch_app` tool action and visible Notepad window. A prior launch attempt was denied by this execution environment (`Access is denied`, `0x80070005`). The sandbox also blocks writes to the normal user Pi profile, so the verified Pi startup used an isolated local profile and did not exercise the user's saved KiloCode login.
- [x] Confirm the bundled Windows CUA driver itself can expose tools over direct MCP stdio: a diagnostic MCP client connected with `cua-driver mcp --direct` and discovered 59 tools. This isolates the current failure to the Pi extension's daemon/named-pipe startup path; it does not yet prove Pi's extension integration.
- [ ] Complete the Notepad launch acceptance check. Direct CUA `launch_app({name:"Notepad"})` was denied by the current execution environment (`Access is denied`, `0x80070005`) and Notepad did not launch. This environment restriction also prevents the full Pi-to-desktop acceptance check; repeat it in a normal interactive Windows session.
- [ ] Load the selected faster-whisper `large-v3` model and verify real microphone audio. The Python 3.12 speech runtime is installed, but the large-v3 weights are not cached and there is no local Windows speech voice available to create a speech fixture in this sandbox. The model-loader smoke used cached `small`; it loaded, but PyAV 19 caused decoding to fail. The installer now pins PyAV `<19`; this environment cannot fetch the downgrade because `pypi.org` DNS fails. No large-v3 transcription or 20-command accuracy/latency benchmark has been verified.
- [x] `npm run setup:file-search` completed on the user's Windows laptop; its smoke check loaded EmbeddingGemma 2 and enabled local file search. Hugging Face's symlink warning is non-fatal; caching works with potentially higher disk use, and Developer Mode/admin is optional.

## Remaining project acceptance gates

### P0 — core demo

- [ ] Complete the typed and spoken command → Pi RPC → approved Windows action → verified outcome flow.
- [ ] Verify the native global Alt+M recording helper on Windows, including duplicate-hotkey conflicts, background tab behavior, and clean shutdown. The focused-page shortcut remains available as fallback.
- [ ] Benchmark the selected faster-whisper large-v3 model against ARK-ASR-0.6B on the target laptop and record transcript accuracy, intent correctness, latency, and memory. The configured model is now large-v3; the worker retains a base fallback for memory allocation failures.
- [ ] Prove one-use approval and accurate action results through the live Pi/CUA RPC path. The project has a one-use approval gate for app launches and a request-bound, one-use volume tool; other unsupported mutations remain blocked.
- [ ] Verify bounded app launch/close, scrolling, volume set/read-back, browser search/navigation, and browser-content isolation. App-window close and bounded scroll are implemented but lack live desktop acceptance runs. Exact master-volume setting is exposed to Pi as a bounded tool and applied through a Windows Core Audio helper with strict 0–100 validation and read-back; live-device acceptance remains outstanding. Laya remains reserved for browser tasks through its Pi adapter.
- [ ] Add UI states for approval, per-action progress, and partial success. WebSocket lifecycle events and UI states for executing, succeeded, failed, and cancelled are implemented.
- [ ] Rehearse the documented demo twice on a Windows 11 laptop.

### P1 — project scope

- [ ] Accept the Laya browser integration on a target Windows laptop. The pinned optional installer, persistent JSONL CDP worker, Pi tool, bridge routing, active-task authorization, independent browser readiness status, and visible Brave CDP launcher are implemented. Run `npm run setup:laya`, then `npm run start:browser`; restart VoicePilot and complete the browser acceptance flow. The launcher first tries Brave's normal profile and never closes an existing browser. If this Brave build refuses CDP on the default profile, `npm run start:browser -- -UseVoicePilotProfile` opens a persistent separate profile in the same visible Brave installation; sign into sites there once. Search and explicit URL navigation are supported; page form entry is not yet enabled. Its MCP `page_decide` tool is a decision interface, not by itself a browser executor. This environment could not start Brave because process-launch approval is disabled, so live CDP attachment remains unverified. See `VoicePilot_Docs/07-laya-browser-integration.md` for the acceptance sequence.
- [ ] Grow the constrained Windows action set from individual verified tools. WinBrow's tool list is a useful backlog reference; its dynamic PowerShell execution path is excluded from VoicePilot. See `VoicePilot_Docs/08-winbrow-review.md`.
- [ ] Restart VoicePilot, add an explicitly approved folder in Settings, index it, perform a real search, and open a result. The installer confirmed real EmbeddingGemma 2 startup; automated tests still use a fake embedder and collection.
- [ ] Add persistent settings, optional Gemma local LLM evaluation, and optional Piper TTS.
- [x] Added offline tests for the audio-upload handler used by the endpoint, STT worker/client lifecycle, Pi RPC, approvals, and service shutdown orchestration. Live HTTP, microphone, and native-process integration remain acceptance checks.
- [x] Latest regression run passes: 10 setup/package tests, 77 bridge tests, 10 speech tests, and 31 file-search tests; production bridge/UI builds pass. The package test also extracts the generated ZIP and runs the included bootstrap against mocked npm commands.
- [ ] Test installation from a clean Windows 11 laptop, including prerequisite installation, Pi model setup, microphone permissions, and model download.

### Distribution

- [x] Provide `npm run install:windows` to install prerequisites with winget and configure Pi plus optional speech runtime.
- [x] Provide `npm run package:windows` to create a clean installable source bundle with a SHA-256 sidecar; archive contents and exclusions are covered by a regression test.
- [ ] Produce and sign a native desktop installer, bundle/update runtimes safely, and provide uninstall/upgrade behavior.
- [ ] Verify repeat installation and upgrade on a second Windows laptop.

## Next executable sequence

1. Restart VoicePilot, then verify real file indexing, semantic search, and open-by-result from an explicitly selected folder.
2. Resolve Pi RPC/CUA startup on a normal Windows session, configure Pi's model/trust prompt, and prove Open Notepad through computer-use.
3. Install speech dependencies, warm the selected faster-whisper `large-v3` model, and record accuracy/latency on actual hardware; verify the global hotkey from another foreground app.
4. Complete live acceptance for approvals, desktop actions, browser search/navigation, and their verified outcomes.
5. Add optional Piper TTS and evaluate local Gemma.
6. Package, repeat installation/upgrade on a clean laptop, and rehearse the demo.
