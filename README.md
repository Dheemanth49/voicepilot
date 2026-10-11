# VoicePilot

VoicePilot is a local-first Windows desktop voice agent. The current vertical slice provides a React command screen, a loopback-only Node bridge, supervised Pi RPC with local-first LLM selection and KiloCode fallback, optional faster-whisper and EmbeddingGemma workers, and repeatable setup scripts. Voice recording can populate the editable command field. When Laya is installed, the bridge asks Laya's local decision model to choose chat, browser, desktop, or file search; Pi then handles chat or executes the selected request-bound capability. The same persistent Laya worker also performs browser tasks. Browser speech synthesis reads successful general-chat replies only; action results stay silent. Live Windows acceptance, LLM provider acceptance, Piper TTS, and native distribution packaging are still in progress.

## Current state

- The six project baseline documents are in [`VoicePilot_Docs`](./VoicePilot_Docs).
- The Node bridge exposes loopback-only health and task-history endpoints.
- Recent task history is stored on this PC under the user's application data folder and can be cleared from the UI.
- Typed commands travel from the React screen through the bridge to Pi RPC.
- Pi starts without its built-in shell and file editing tools enabled.
- The bridge reports Pi and desktop-tool status separately; it does not claim that an action succeeded unless Pi returned a task result.
- The bridge accepts one simple app launch or named-window close, one bounded vertical scroll (up to five lines/pages), one explicit system-volume percentage (0–100) or mute/unmute request, one browser search/navigation task, or one search of an explicitly approved folder. Use `open example.com` or an explicit HTTP(S) URL to navigate; bare domains are treated as browser destinations rather than app names. Notepad is allowlisted; other app launches require an explicit, short-lived approval in the UI. Window close sends Alt+F4 to the selected app window and checks that its window ID disappears; it does not force-terminate the process. Arbitrary paths, shell apps, compound desktop tasks, and unsupported computer-use tools are blocked. Volume and mute success require a Windows Core Audio read-back.
- For volume tasks, Pi must call VoicePilot's bounded `voicepilot_set_volume` tool. The bridge binds that one-use call to the exact level the user requested, applies it through Windows Core Audio, and verifies the result before reporting success.
- For mute tasks, Pi must call `voicepilot_set_mute` with the explicit requested state. The bridge binds that one-use call to the active user task and verifies Windows Core Audio read-back before reporting success.
- Microphone capture uses the browser's MediaRecorder API. Transcription runs locally through faster-whisper when explicitly enabled; transcripts require a separate Send command click.
- Optional file search indexes only folders entered in Settings. EmbeddingGemma 2 and ChromaDB run in a separate local Python worker; changed and deleted files are reconciled on each manual re-index. Pi receives result IDs and snippets, never absolute paths; opening uses a recent result ID and repeats approved-root and content-hash checks. Matching snippets can still be sent to a configured remote Pi model provider.

## Requirements

- Windows 11
- Node.js 22.19 or newer
- Git for Windows (provides the Bash runtime Pi expects on native Windows)

## Install on a Windows 11 laptop

After extracting the project folder on a Windows 11 laptop, run this from PowerShell. This entry point works before Node.js is installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

To create a clean project archive for another laptop, run `npm run package:windows`. It writes `VoicePilot-<version>-windows.zip` and a SHA-256 sidecar under `.artifacts`; local settings, API keys, installed modules, and model caches are excluded. Extract the zip on the target laptop and run the bootstrap command above.

The bootstrap installs missing Node.js, Git for Windows, and Python prerequisites with winget, then runs `npm ci` from the checked-in root lockfile before installing the pinned Pi integration and optionally local speech/file-search runtimes. It enables the native Alt+M helper and local speech worker when setup completes. If winget installs a prerequisite, reopen PowerShell and rerun the command so the new PATH is loaded. After Node.js is installed, `npm run install:windows` is an equivalent shortcut. Internet access is required for the first setup. Model weights download on first speech use.

### Install just the Pi integration

```powershell
npm run setup:pi
```

`setup:pi` installs the pinned Pi CLI, Windows computer-use extension, and KiloCode model provider into `tools/pi` from a checked-in lockfile. It requires access to npm the first time. The CUA driver is included as a platform-specific package; no separate driver download is needed. VoicePilot uses its project-owned `tools/pi/voicepilot-computer-use.mjs` adapter to connect to `cua-driver mcp --direct`, avoiding the upstream extension's separate daemon path on Windows. The bridge prefers this adapter alongside the project-pinned Pi runtime, and can still discover Pi's managed Windows install under `%USERPROFILE%`'s `.pi\agent` folder (or `PI_CODING_AGENT_DIR`) for the user's provider login. Other computers can use the normal project installer, so the app does not depend on this laptop's profile path.

To configure the local Gemma 4 E2B model, run `npm run setup:llm`. If Ollama is missing, the script asks before installing it with winget. It checks the configured model against `ollama list`, pulls it only if it is missing, verifies the local model catalog, merges the Ollama provider/model into Pi's `models.json`, and sets the local LLM values in `.env`; it preserves other provider entries. A model download requires several GB of free disk space. To use another already installed local Ollama model, set `VOICEPILOT_LOCAL_LLM_MODEL` before running setup. [Ollama's Gemma 4 library](https://ollama.com/library/gemma4) lists the E2B model and current download sizes.

For local voice transcription, run `npm run setup:speech`, set `VOICEPILOT_STT_ENABLED=1` in `.env`, and restart the bridge. The selected default is faster-whisper `large-v3`, downloaded on first use; allow several GB of disk space and time. Setup pins a PyAV version compatible with faster-whisper 1.2.1. In automatic device mode, if CUDA runs out of memory during model loading or transcription, the worker releases the CUDA model where possible, switches to the configured fallback model (default `base`) on CPU, and updates the bridge's reported model/device. After recording, the UI reports detected language, active model/device, inference latency, and end-to-end time from recording stop to transcript. The model/device can be changed with the documented environment variables. The bridge reports speech as initializing until its model load finishes.

To verify an audio file without starting the bridge or UI, run `npm run transcribe:speech -- "C:\\recordings\\voice-command.wav"`. The helper uses the configured `VOICEPILOT_PYTHON` and CUDA runtime, then prints the transcript, detected language, active model/device, and transcription latency. It may download the configured model on first use.

On an NVIDIA laptop, run `npm run setup:speech:gpu` to stage a separate CUDA speech environment and verify a CUDA model load before switching VoicePilot to it. This downloads large NVIDIA cuBLAS/cuDNN packages (about 1 GB) and the configured Whisper model. The GPU environment is separate from the CPU speech environment; setup leaves the CPU selection untouched if installation or smoke checks fail. The pinned stack is faster-whisper 1.2.1, CTranslate2 4.6.3, CUDA 12.8 libraries, and cuDNN 9.8. Speech DLL paths are provided only to the worker. Use `npm run diagnose:gpu` for read-only adapter, runtime, and active-device details. GPU setup requires a compatible NVIDIA driver; the real large-v3 transcription check still needs to be completed on the target RTX laptop.

For semantic file search, run `npm run setup:file-search` and restart VoicePilot. This installs a dedicated Python 3.12 runtime, ChromaDB, and EmbeddingGemma 2; it automatically selects the separate CUDA environment when `nvidia-smi` is available and otherwise uses CPU. The Windows bootstrap follows the same GPU-first selection when you opt into file search; type `CPU` at its prompt to force CPU mode. To require a specific runtime, use `npm run setup:file-search:gpu` or `npm run setup:file-search:cpu`. The model download requires disk space and internet access. In Settings, enter a folder path you approve, click **Add folder**, then **Index**. Re-index after file changes; unchanged files are skipped and deleted files are removed. Search results expose relative paths and short snippets. Open a result with its **Open file** button. Use requests such as `find my resume` or `find my notes about ...` in the command box to search via Pi; add “and open the result” only if you want Pi to open one match. Matching snippets are returned to the configured Pi model provider, so use a local provider if their contents must remain on this device. `npm run test:file-search` exercises indexing and result-ID validation without downloading the embedding model.

GPU setup does not install NVIDIA drivers: install a compatible driver first, then rerun setup. VoicePilot selects CUDA 13 wheels for driver 580 or newer and CUDA 12.6 wheels for driver 525–579; an RTX 50-series card requires the CUDA 13 path. The PyTorch wheels include their CUDA user-space runtime, while the NVIDIA driver remains a system prerequisite ([PyTorch wheel index](https://download.pytorch.org/whl/), [NVIDIA CUDA compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)). EmbeddingGemma remains FP32. Setup keeps the existing CPU environment and activates the GPU environment only after its model smoke check succeeds. Set `VOICEPILOT_FILE_SEARCH_DEVICE=cpu` or `cuda` to force a device; leave it as `auto` to use CUDA when available and otherwise report the CPU fallback.

`npm run diagnose:gpu` also reports the active STT and file-search device from bridge health when VoicePilot is running.

Install the Laya runtime with `npm run setup:laya`. It uses a separate Python 3.12 environment and pins the upstream source revision. The bridge asks Laya's typed-choice `Decider` to choose chat, browser, desktop, or file search. Pi handles chat or executes the selected task; browser tasks reuse the same persistent Laya worker and model. If Python 3.12 is missing, setup installs it with winget when available. VoicePilot does not download or launch a headless browser. Run `npm run start:browser` to open the installed Brave visibly with CDP and configure its local endpoint in `.env`; restart VoicePilot afterward. CDP cannot be enabled retroactively on a running browser. The launcher binds CDP to loopback and allows the Python CDP client's exact loopback origin. Chromium 136+ may refuse the default Brave profile for remote debugging; in that case, close Brave and run `npm run start:browser -- -UseVoicePilotProfile` to open a persistent VoicePilot profile in the same Brave installation. You will need to sign into sites in that profile once. VoicePilot never closes your existing Brave session. Every browser task creates a fresh tab in the connected Brave session and leaves existing tabs untouched. The first browser slice supports `search the web for ...`, `search YouTube for ...`, `open google.com and search for ...`, `browse to https://...`, `visit https://...`, and `open https://...`; Google queries are sent through a direct search URL, and general page form entry is not yet supported. The standalone worker entry point is `services/browser/laya_worker.py`.

The browser launcher detects the Vite port selected by `npm run dev` (including when 5173 is occupied) and opens that VoicePilot page instead of a blank tab. Start the app first, then run `npm run start:browser`.

Run the speech worker protocol tests without downloading models with `npm run test:speech`.

Run the bridge policy/discovery, speech worker, and file-search tests together with `npm test`. Build both the bridge and UI for production with `npm run build`.

After setup, configure a local model in Pi's `models.json` and trust the project once so its local extensions are allowed to load. VoicePilot explicitly loads only its computer-use, approval, KiloCode provider, browser, and file-search extensions while keeping Pi's other extensions disabled. VoicePilot can also discover Pi under `%USERPROFILE%`'s `.pi\agent` folder or `PI_CODING_AGENT_DIR` and load the cached extensions directly; the Pi launcher does not need to be on the bridge process's `PATH`.

```powershell
& .\tools\pi\node_modules\.bin\pi.cmd
```

VoicePilot selects a running local model first and falls back to KiloCode when the local provider/model or inference endpoint is unavailable. If the local model returns an error before any tool action starts, VoicePilot retries that request once with KiloCode; it never replays a request after a tool action has started. For Ollama, add a provider and model to `%USERPROFILE%\.pi\agent\models.json` (merge this with any existing entries):

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

LLM selection defaults to local-first. Set `VOICEPILOT_LLM_PROVIDER=kilocode` in `.env` to always use KiloCode as the primary model; KiloCode must be available in Pi. Set it to `local` (or leave it unset) to use the configured local model first, with KiloCode as fallback. Local settings are `VOICEPILOT_LOCAL_LLM_PROVIDER`, `VOICEPILOT_LOCAL_LLM_BASE_URL`, and `VOICEPILOT_LOCAL_LLM_MODEL`; their defaults are `ollama`, `http://127.0.0.1:11434/v1`, and the first available Ollama model. `VOICEPILOT_KILOCODE_MODEL` optionally selects an exact KiloCode model ID. System Status displays the selected provider/model. Start VoicePilot with `npm run dev` after configuration.

## Start the development app

```powershell
npm run dev
```

`npm run dev` prints the selected UI and bridge URLs. It prefers `http://127.0.0.1:5173` for the UI and `http://127.0.0.1:8787` for the bridge, then selects another loopback port when either default is occupied. Use Record command, grant microphone permission, then Stop recording. Alt+M toggles recording while the VoicePilot page is focused. Review the transcript and click Send command. Accepted tasks return immediately and update over the local WebSocket; the UI polls for final status if the socket disconnects. The bridge rejects audio larger than 25 MB and removes temporary audio after transcription.

## First milestone

After setup and model configuration, submit `Open Notepad` from the VoicePilot UI and confirm that Notepad visibly opens. For this single allowlisted action, the explicit submit is the user's authorization. A simple request such as `Open Calculator` pauses for an in-app approval; approvals expire after 60 seconds and authorize only that exact action once. Paths, shell apps, multi-action requests, and other mutating computer-use tools remain blocked. If extensions are not loaded, run Pi interactively from this project once to accept project trust. Health reports Pi RPC and desktop-tool readiness separately; VoicePilot rejects desktop tasks until the computer-use extension has discovered its live CUA tool surface.

The Pi CLI (`1.1.0`), computer-use extension (`0.1.24`), KiloCode provider (`0.1.2`), and their transitive dependencies are pinned in `tools/pi/package.json` and `tools/pi/package-lock.json`. Model credentials stay in the user's Pi profile; they are not stored in this repository. Copy `.env.example` to `.env` to customize local bridge/UI URLs.

## MVP work still in progress

- Verify the Pi setup, project trust, and visible Notepad launch through the computer-use extension on a normal Windows session.
- Live-accept the expanded action surface on Windows: named-window close and bounded scrolling are implemented but need real desktop runs; volume, mute/unmute, and app launch also need target-laptop acceptance. Non-Notepad launches require approval.
- Verify real transcription with the selected faster-whisper `large-v3` model and the native global Alt+M helper on Windows. Model comparison and benchmarking are not planned.
- Finish browser and file-search acceptance on a normal Windows laptop, implement persistent user settings, evaluate the optional local LLM, and add Piper TTS.

The planned browser path uses [laya-browser-agent](https://github.com/ChenneyZhuang/laya-browser-agent) in an optional local Python worker. It runs separately from Pi's Windows computer-use path and faster-whisper. See `VoicePilot_Docs/07-laya-browser-integration.md` before enabling its PyTorch/model downloads.
- Package the app for a fresh Windows laptop and rehearse the full voice-to-action flow.

