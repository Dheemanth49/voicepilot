# File Search GPU Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional CUDA acceleration for EmbeddingGemma semantic file search on Windows while preserving CPU setup and FP32 inference.

**Architecture:** Give file search an explicit `auto|cpu|cuda` preference and have the worker report the device it actually loaded. Keep the existing CPU virtual environment intact; provision an optional GPU environment separately and select it only after its packages and a model smoke check succeed. Expose actual file-search device and fallback status through bridge health and the setup UI.

**Tech Stack:** Python 3.12, PyTorch, Sentence Transformers, PowerShell, Node.js/TypeScript bridge, React.

**Spec:** `docs/superpowers/specs/2026-10-11-gpu-acceleration-design.md`

## Global Constraints

- Keep EmbeddingGemma in `torch.float32` on CPU and CUDA.
- File search accepts `auto`, `cpu`, or `cuda`; default is `auto`.
- `auto` prefers CUDA only when driver, runtime, and backend are usable; otherwise it runs on CPU and reports why.
- Explicit `cuda` fails startup with an actionable diagnostic when CUDA is unavailable.
- If auto CUDA model initialization, allocation, or embedding inference fails, attempt CPU once, report the CUDA failure, and do not loop/reload after startup failure.
- CPU-only installation remains available without an NVIDIA GPU or administrator rights.
- GPU packages stay inside a separate VoicePilot virtual environment; do not change global Python packages or system PATH.
- GPU setup failure must leave the already installed CPU environment usable.

## Review Focus

1. An invalid device preference must fail clearly before model allocation; test `gpu` is rejected.
2. CUDA unavailable in `auto` must select CPU and retain an explanatory reason; test with `torch.cuda.is_available() == False`.
3. CUDA model allocation can fail despite successful device detection; test one CPU retry and no second CUDA attempt.
4. FP32 can silently regress when enabling CUDA; test `model_kwargs["torch_dtype"] is torch.float32` for both selected devices.
5. An interrupted optional GPU install must not alter CPU runtime selection; test a failed staged environment probe leaves the `.env` Python selection unchanged.

---

### Task 1: Explicit device selection and FP32 CUDA model loading

**Files:**
- Modify: `services/file_search/index.py`
- Modify: `services/file_search/test_index.py`

**Interfaces:**
- Add `SentenceTransformerEmbedder(model_id: str = MODEL_ID, device_preference: str | None = None)`.
- Expose `active_device: str`, `device_preference: str`, and `fallback_reason: str | None` on the embedder.
- Parse `VOICEPILOT_FILE_SEARCH_DEVICE`, accepting only `auto`, `cpu`, and `cuda`.

- [x] **Step 1: Add tests for preference validation and selection**

Patch the constructor imports with fake `torch.cuda.is_available` and fake `SentenceTransformer`. Assert CPU preference never queries/uses CUDA; auto with CUDA available attempts CUDA; auto without CUDA constructs on CPU with an explanatory fallback reason; explicit CUDA without CUDA raises a `RuntimeError`; and invalid preference raises `ValueError`.

- [x] **Step 2: Run only the new tests and confirm they fail**

Run: `python -m unittest services.file_search.test_index -v`  
Expected: new constructor/device assertions fail because the embedder currently hard-codes CPU and has no device state.

- [x] **Step 3: Implement selection and one-time CUDA-to-CPU recovery**

Resolve preference in the constructor. For `auto`, check `torch.cuda.is_available()` and try CUDA if available. On CUDA model-load failure, record the exception class/message, release the failed local model reference, and construct once on CPU. For explicit CUDA, propagate a concise actionable error and do not retry CPU. Keep model kwargs at `{"torch_dtype": torch.float32}` for either device and preserve the current paging-file error translation when the CPU attempt also fails.

- [x] **Step 4: Run file-search tests and confirm they pass**

Run: `python -m unittest services.file_search.test_index -v`  
Expected: all index tests pass, including the new device/fallback/FP32 cases.

### Task 2: Report actual embedding runtime through the worker protocol

**Files:**
- Modify: `services/file_search/worker.py`
- Modify: `services/file_search/test_worker.py`

**Interfaces:**
- Worker ready record: `{"type":"ready","model":"google/embeddinggemma-2","device":"cpu|cuda","devicePreference":"auto|cpu|cuda","backend":"pytorch","fallbackReason":string|null,"dtype":"float32"}`. If inference causes auto fallback, the worker emits a `runtime` record with updated fields before the operation response.
- `status` action returns the same runtime fields plus the existing `roots` value.

- [x] **Step 1: Add worker protocol tests**

Inject a fake embedder with each device and fallback state. Assert ready and status records include actual device, preference, fallback reason, and `dtype: "float32"`; ensure the existing model and roots fields remain present.

- [x] **Step 2: Run worker tests and confirm the new assertions fail**

Run: `python -m unittest services.file_search.test_worker -v`  
Expected: current ready and status records omit runtime details.

- [x] **Step 3: Pass the device preference into the embedder and serialize its runtime state**

In `create_service`, pass `os.environ.get("VOICEPILOT_FILE_SEARCH_DEVICE", "auto")`. Keep a single helper to build the runtime metadata for both ready and status responses so the values cannot diverge. Do not report CUDA before the model constructor returns successfully.

- [x] **Step 4: Run all file-search tests**

Run: `python -m unittest discover -s services/file_search -p test_*.py -v`  
Expected: all existing extraction/index/worker tests and new runtime protocol tests pass.

### Task 3: Add isolated, rerunnable GPU provisioning

**Files:**
- Create: `services/file_search/requirements-gpu-cu126.txt`
- Create: `services/file_search/requirements-gpu-cu130.txt`
- Create: `services/file_search/requirements-base.txt`
- Modify: `services/file_search/requirements.txt`
- Modify: `scripts/install-file-search.ps1`
- Create: `scripts/voicepilot-setup-common.psm1`
- Create: `scripts/file-search-gpu-setup.test.mjs`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Make `npm run setup:file-search` auto-select the GPU runtime when `nvidia-smi` is available and otherwise use CPU.
- Keep explicit `npm run setup:file-search:gpu` (`-Gpu`) and `npm run setup:file-search:cpu` (`-Cpu`) commands for users who want to force a runtime.
- GPU environment path: `.voicepilot-file-search\venv-gpu`; after validation set `VOICEPILOT_FILE_SEARCH_PYTHON` to that environment’s `Scripts\python.exe` and `VOICEPILOT_FILE_SEARCH_DEVICE=auto` in the project `.env`.

- [x] **Step 1: Add a PowerShell test harness for driver selection, environment-key preservation, and old-driver rejection before CPU configuration changes**

The existing installer tests cover CUDA driver selection, GPU setup's old-driver rejection, and environment-key preservation. Follow-up automated coverage for default GPU detection and the explicit `-Cpu` path remains pending.

- [x] **Step 2: Run the installer tests and confirm the new cases fail**

Run: `node --test scripts/install-file-search.test.mjs`  
Expected: the current script does not accept `-Gpu`, has no GPU requirements file, and uses one environment.

- [x] **Step 3: Pin a Windows/Python 3.12 CUDA PyTorch set and implement staged provisioning**

Pin PyTorch/torchvision to `2.14.1/0.29.1` and verify the Windows/Python 3.12 wheel files against the official PyTorch indexes. Select cu126 for NVIDIA driver 525–579 and cu130 for driver 580 or newer; require cu130 for RTX 50-series adapters. Move shared non-Torch dependencies into `requirements-base.txt`; make CPU and GPU requirement manifests each include that base and exactly one CPU/CUDA torch+torchvision pair. Create and install the GPU venv without modifying `.voicepilot-file-search\venv`. Run a GPU-environment probe that imports torch, reports `torch.version.cuda` and `torch.cuda.is_available()`, then loads EmbeddingGemma in FP32 with `device="cuda"` and performs one short encode. Only after all probes succeed, update the two GPU-related `.env` keys. Preserve prior `.env` bytes/settings on any failure and print the captured error plus retry guidance.

- [x] **Step 4: Add a CPU-only and rerun installer verification**

Run: `node --test scripts/install-file-search.test.mjs`  
Expected: explicit CPU setup remains available; repeated GPU setup reuses/reconciles the GPU venv; failed GPU provisioning leaves CPU setup selectable.

- [x] **Step 5: Document CPU and GPU installation plus diagnostics output**

In README, document the CPU command, GPU command, requirement for a user-installed compatible NVIDIA driver, expected first model download, `.env` device preference, and CPU fallback. Do not tell users to edit the global PATH or install a driver through VoicePilot.

### Follow-up: Automatic runtime selection

- [x] Make the generic file-search setup choose the GPU environment when `nvidia-smi` is present.
- [x] Add `npm run setup:file-search:cpu` so CPU selection stays explicit and available.
- [ ] Add mocked installer coverage for automatic GPU selection and forced CPU selection.

### Task 4: Surface file-search device status in bridge health and setup UI

**Files:**
- Modify: `apps/bridge/src/file-search-client.ts`
- Modify: `apps/bridge/src/file-search-client.test.ts`
- Modify: `apps/bridge/src/server.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/ui/src/App.tsx`
- Modify: `apps/ui/src/styles.css` only if an existing status style cannot represent the device/reason.

**Interfaces:**
- `FileSearchClient` stores `activeDevice`, `devicePreference`, `fallbackReason`, and `activeModel` from the ready record and clears them on stop/exit.
- Health `providers.fileSearchRuntime` is `{ device, devicePreference, dtype, fallbackReason }` only when the worker reports ready.

- [x] **Step 1: Add client tests for actual device and fallback state**

Extend `file-search-client.test.ts` fake worker ready record to include runtime metadata. Assert health-facing getters hold the exact reported values, and stop/exit clears active device and fallback state.

- [x] **Step 2: Run the focused bridge test and confirm it fails**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="device|runtime" apps/bridge/src/file-search-client.test.ts`  
Expected: runtime getters are currently absent.

- [x] **Step 3: Store worker runtime fields and expose backward-compatible health**

Update `FileSearchClient` ready handling and server health assembly. Preserve `providers.fileSearchModel` and existing component status. Add `fileSearchRuntime` only when actual runtime fields exist.

- [x] **Step 4: Render CPU/GPU label and fallback reason in setup status**

Extend the UI health type to read `fileSearchRuntime`. Show `NVIDIA GPU (CUDA)` only when `device === "cuda"`, otherwise show `CPU`; if `fallbackReason` is non-empty, display it as a short setup footnote. Do not infer device from adapter detection.

- [x] **Step 5: Run focused bridge/UI build checks**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="device|runtime" apps/bridge/src/file-search-client.test.ts` and `npm run build`  
Expected: focused assertions pass and both bridge and UI production builds succeed.

### Task 5: Run subsystem regression checks and record hardware acceptance

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`

- [x] **Step 1: Run the full existing test and build commands**

Run: `npm run test:file-search`, `npm --prefix apps/bridge test`, and `npm run build`.  
Expected: all suites pass without loading real model weights in unit tests.

- [ ] **Step 2: Run CPU laptop acceptance**

Use the normal CPU setup on a machine without a supported NVIDIA CUDA device. Start VoicePilot and confirm file search reports CPU, indexes a selected fixture folder, returns a query result, and opens only a returned result.

- [ ] **Step 3: Run NVIDIA laptop acceptance**

On the user’s RTX laptop, run GPU setup and diagnostics, start VoicePilot, verify the file-search health state reports `cuda` only after model load, index/search a folder, and confirm the device with PyTorch diagnostics during inference. Record GPU model, driver, VRAM, selected PyTorch build, CUDA runtime, and result in `IMPLEMENTATION_STATUS.md`.

- [ ] **Step 4: Mark only verified acceptance items complete**

Update the status checklist with CPU and GPU outcomes independently. If hardware is unavailable, leave the GPU acceptance unchecked and state the missing on-device evidence.
