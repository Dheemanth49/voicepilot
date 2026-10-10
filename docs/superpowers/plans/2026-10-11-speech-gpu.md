# Speech GPU Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional NVIDIA CUDA acceleration to faster-whisper on Windows and report the actual transcription device while preserving the existing CPU path.

**Architecture:** Keep current CPU speech environment as the fallback. Provision a separate GPU environment with pinned faster-whisper/CTranslate2 and verified CUDA/cuDNN runtime files, activate its interpreter and DLL paths only after smoke checks pass, and have the worker report actual backend/device. Extend bridge health and the setup UI using worker-reported runtime details.

**Tech Stack:** Python 3.12, faster-whisper, CTranslate2, Windows CUDA/cuDNN DLLs, PowerShell, Node.js/TypeScript bridge, React.

**Spec:** `docs/superpowers/specs/2026-10-11-gpu-acceleration-design.md`

## Global Constraints

- Speech device preference is `auto`, `cpu`, or `cuda`; default is `auto`.
- `auto` prefers CUDA only if the installed NVIDIA driver, CUDA/cuDNN runtime, and CTranslate2 backend are usable.
- Explicit `cuda` must fail with actionable setup/driver guidance if CUDA is unavailable.
- Preserve the current CPU environment; GPU setup runs in a separate VoicePilot environment and is repeatable.
- Do not install or modify system NVIDIA drivers, global Python packages, or permanent system PATH.
- faster-whisper Windows GPU runtime must be pinned and verified before deployment; the worker receives DLL search paths in its child-process environment only.
- Actual device status is reported only after a successful model load; automatic CUDA failure retries CPU once and reports the reason.

## Review Focus

1. Automatic mode can mistake a discoverable driver for a working CTranslate2 backend; test `ctranslate2.get_supported_compute_types("cuda")` failure falls back to CPU.
2. CUDA DLLs may be available to the installer but absent from the bridge child process; test the child environment includes the selected runtime directory and the parent process environment remains unchanged.
3. Explicit CUDA must not silently use CPU; test unavailable runtime emits startup error and exits nonzero.
4. A large-v3 GPU allocation failure differs from a missing CUDA library; test CUDA initialization errors may CPU-retry in auto mode, while model memory fallback behavior remains clearly distinguished.
5. The existing CPU speech setup must remain launchable after a failed GPU setup; test staged GPU setup writes activation config only after model load smoke succeeds.

---

### Task 1: Make STT worker device choice and startup reporting explicit

**Files:**
- Modify: `services/speech/stt_worker.py`
- Modify: `services/speech/test_stt_worker.py`

**Interfaces:**
- Continue reading `VOICEPILOT_STT_DEVICE` with accepted values `auto`, `cpu`, and `cuda`.
- Ready event extends to `{"type":"ready","provider":"faster-whisper","model":string,"requestedModel":string,"fallbackFrom":string|null,"device":"cpu|cuda","devicePreference":"auto|cpu|cuda","backend":"ctranslate2","fallbackReason":string|null}`.
- Preserve request response fields and add actual `device` to successful transcriptions.

- [x] **Step 1: Add worker tests for CUDA selection, explicit errors, and fallback**

Extend `FakeModel` to capture constructor device and allow configured CUDA failures. Add tests for CPU preference, auto CUDA success, auto CUDA initialization failure followed by one CPU load, explicit CUDA failure with no CPU constructor, and actual device in ready/transcription records. Keep existing small-model memory-fallback test and assert it continues using the configured device.

- [x] **Step 2: Run STT tests and confirm the new assertions fail**

Run: `npm run test:speech`  
Expected: current worker passes through `device="auto"` but does not determine/report actual runtime or explicit fallback behavior.

- [x] **Step 3: Implement CTranslate2-aware device selection**

For `auto`, inspect the CTranslate2-supported CUDA compute types before selecting CUDA. If CUDA cannot initialize, instantiate faster-whisper on CPU once and attach the exact GPU failure reason. For explicit `cuda`, emit `startup_error` with that reason and return nonzero. Keep model-size OOM fallback distinct from device fallback; a configured base model may use the selected device, but any failure chain must identify whether the primary failure was allocation or CUDA runtime initialization. Report `device="cuda"` only after the CUDA `WhisperModel` constructor succeeds.

- [x] **Step 4: Run STT unit tests**

Run: `npm run test:speech`  
Expected: all existing protocol tests and new device/fallback tests pass.

### Task 2: Pin and stage the Windows CUDA/cuDNN speech runtime

**Files:**
- Create: `services/speech/requirements-gpu.txt`
- Create: `scripts/install-speech-gpu-runtime.ps1`
- Modify: `scripts/install-speech.ps1`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Keep `npm run setup:speech` as CPU setup.
- Add `npm run setup:speech:gpu` for optional staged CUDA setup.
- GPU environment: `.voicepilot-speech\venv-gpu`.
- GPU runtime location: `.voicepilot-speech\cuda-runtime` (pinned extracted package files).
- On successful verification, set `.env` values `VOICEPILOT_PYTHON` to the GPU venv interpreter and `VOICEPILOT_STT_DEVICE=auto`; the bridge adds the CUDA runtime directory to the spawned STT process PATH only.

- [x] **Step 1: Establish the exact supported Windows runtime source and pins**

Read the pinned faster-whisper/CTranslate2 Windows GPU documentation and the chosen runtime archive’s release metadata. Select a specific runtime release and package versions compatible with project Python 3.12, faster-whisper 1.2.1, the pinned CTranslate2 wheel, and supported NVIDIA driver range. Record the source URL, exact versions, archive hash/signature verification method, and required DLL names in `services/speech/requirements-gpu.txt` comments and setup documentation. Do not use an unpinned latest URL or execute downloaded binaries.

- [x] **Step 2: Add installer tests for staged activation and process-scoped PATH**

Add `scripts/install-speech-gpu.test.mjs` with a temporary repo/.env fixture and mocked Python, archive, and smoke-probe invocations. Cover CPU path unchanged, GPU files extracted only into the VoicePilot runtime directory, expected checksum mismatch rejected, failed CUDA/model probe leaves `.env` selecting CPU Python, successful probe writes GPU interpreter/device preferences, and an already running parent process PATH is not altered.

- [x] **Step 3: Run installer tests and confirm they fail**

Run: `node --test scripts/install-speech-gpu.test.mjs`  
Expected: the current installer has no GPU mode or staged runtime handling.

- [x] **Step 4: Implement idempotent staged setup**

Create/reuse `.voicepilot-speech\venv-gpu`, install exact faster-whisper/CTranslate2 dependencies, download the pinned runtime archive to a temporary file, verify its pinned integrity value before extraction, then extract required DLLs to `.voicepilot-speech\cuda-runtime`. Run import and CTranslate2 CUDA-support probes followed by a warm model-load smoke using the configured STT model. Update `.env` only after all probes succeed; write it atomically while preserving unrelated keys and previous CPU configuration on every failure.

- [x] **Step 5: Run installer tests and script parse validation**

Run: `node --test scripts/install-speech-gpu.test.mjs`; parse `scripts/install-speech.ps1` and `scripts/install-speech-gpu-runtime.ps1` with PowerShell’s parser.  
Expected: tests pass and scripts parse without errors.

### Task 3: Pass the scoped CUDA runtime environment into STT worker

**Files:**
- Modify: `apps/bridge/src/stt-client.ts`
- Modify: `apps/bridge/src/stt-client.test.ts` (create if absent)
- Modify: `services/speech/test_stt_worker.py` only if startup metadata needs an additional assertion.

**Interfaces:**
- STT client stores `activeDevice`, `devicePreference`, `backend`, and `fallbackReason` from the ready record.
- `VOICEPILOT_STT_CUDA_RUNTIME` names the optional runtime directory; when present, prepend it to a child-only PATH value.

- [x] **Step 1: Add STT client lifecycle tests**

Use a fake child process to emit a ready JSON line. Assert runtime fields are stored; the child receives the CUDA runtime directory prepended to PATH when configured; the current process PATH is unchanged; and stop/exit clears actual-device fields.

- [x] **Step 2: Run the focused bridge tests and confirm they fail**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="STT runtime|CUDA runtime" apps/bridge/src/stt-client.test.ts`  
Expected: current STT client stores only the model and has no scoped runtime PATH setup.

- [x] **Step 3: Add child-only runtime environment and ready metadata handling**

Construct `workerEnv` from `process.env`; if `VOICEPILOT_STT_CUDA_RUNTIME` is a valid directory, set only `workerEnv.PATH` to that directory plus the existing PATH. Pass `workerEnv` to `spawn`, store the worker’s reported runtime fields, and clear them in both stop and exit paths. Do not mutate `process.env.PATH`.

- [x] **Step 4: Run focused STT client tests**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="STT runtime|CUDA runtime" apps/bridge/src/stt-client.test.ts`  
Expected: all new client assertions pass.

### Task 4: Add speech runtime fields to health/UI and GPU diagnostics

**Files:**
- Create: `apps/bridge/src/runtime-status.ts`
- Create: `apps/bridge/src/runtime-status.test.ts`
- Modify: `apps/bridge/src/server.ts`
- Modify: `apps/bridge/src/stt-client.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/ui/src/App.tsx`
- Modify: `apps/ui/src/styles.css` only if necessary for status text.
- Create: `scripts/diagnose-gpu.ps1`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Health `providers.sttRuntime` is `{ device, devicePreference, backend, fallbackReason }` only after successful STT model startup.
- Add `npm run diagnose:gpu` to report NVIDIA adapter/driver, file-search PyTorch CUDA build and availability, STT CTranslate2 supported compute types and runtime DLL visibility, requested preferences, and active service runtime values when the bridge health endpoint responds.

- [x] **Step 1: Add health contract and UI mapping tests**

Create `apps/bridge/src/runtime-status.test.ts` for a small exported `buildRuntimeStatus` helper in `apps/bridge/src/runtime-status.ts`. Assert the helper includes `sttRuntime` and `fileSearchRuntime` only when actual worker metadata exists and omits them before model readiness. Extend `packages/contracts/src/index.ts` HealthResponse provider types to cover the optional records. Add a UI type/build assertion for rendering CPU/CUDA plus fallback text based exclusively on actual worker metadata.

- [x] **Step 2: Run focused health/UI checks and confirm they fail**

Run: `node --import tsx --test --test-concurrency=1 apps/bridge/src/runtime-status.test.ts` and `npm --prefix apps/ui run build`.  
Expected: health currently omits device/runtime and the UI has no device label.

- [x] **Step 3: Extend health and render the real STT device**

Preserve `providers.sttModel` and all current component values. Add `sttRuntime` from `SttClient` when active. Render `NVIDIA GPU (CUDA)` only for `device === "cuda"`, otherwise `CPU`, and show fallback reason when the actual device is CPU after an attempted auto CUDA startup.

- [x] **Step 4: Implement diagnostics with nonzero/missing components handled**

In PowerShell, collect `Get-CimInstance Win32_VideoController` adapter name/driver version, `nvidia-smi` output when available, Python path/version for both isolated environments, `torch.version.cuda` and `torch.cuda.is_available()` for file search, CTranslate2 supported compute types for speech, and required CUDA/cuDNN DLL resolution from the configured runtime directory. Query local `/api/health` with a short timeout and display active service devices when reachable; clearly print “bridge unavailable” if it is stopped. Missing GPU/`nvidia-smi` must be reported as unavailable, not terminate diagnostics. Do not write settings or install anything in diagnostic mode.

- [x] **Step 5: Run health/UI builds and diagnostics fixture checks**

Run bridge focused tests, `npm --prefix apps/ui run build`, and a PowerShell parser check for `scripts/diagnose-gpu.ps1`.  
Expected: health contract and UI build succeed; diagnostics parse cleanly and return understandable output when hardware commands are absent.

### Task 5: Run speech regressions and laptop acceptance

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`

- [x] **Step 1: Run full project test and build suites**

Run `npm run test` and `npm run build`.  
Expected: current and new bridge/speech tests pass and production builds succeed.

- [ ] **Step 2: Verify CPU transcription remains available**

With CPU speech setup selected, start the worker, transcribe a short local speech fixture, and confirm health reports CPU. Confirm no CUDA runtime directory is required.

- [ ] **Step 3: Verify RTX transcription on the target laptop**

Run `npm run setup:speech:gpu`, `npm run diagnose:gpu`, start VoicePilot, warm large-v3, transcribe a real microphone recording, and confirm both worker health metadata and CTranslate2 diagnostics report CUDA. Record GPU model, driver, VRAM, exact runtime/package pins, model, latency, and result in `IMPLEMENTATION_STATUS.md`. If GPU acceptance fails, record the actual error and keep the acceptance box unchecked.
