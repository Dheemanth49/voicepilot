# SDD ledger — plan: docs/superpowers/plans/2026-10-11-file-search-gpu.md

Workspace ruling: `E:\centel` has no `.git` directory, so a Git worktree and task-start/commit script cannot be used. User said “continue” after reviewing the implementation plans; proceed in the approved workspace without overwriting unrelated files, keep a task ledger, and verify each planned change.

Pre-flight: FileSearchClient's runtime fields are produced by the file-search plan; shared health providers consume them in the speech plan's `buildRuntimeStatus` helper. Execute file-search first, then speech. Package scripts and README are edited by both plans; apply sequentially and preserve existing values.

## File search GPU plan

- Task 1: complete — added preference validation, CUDA detection, one-time auto fallback on model load/encode failures, explicit-CUDA failure, and FP32 assertions; 7 tests pass.
- Task 2: complete — worker ready/status reports device, preference, backend, fallback reason, and FP32; worker emits runtime changes after inference fallback; 7 worker tests pass.
- Task 3: complete — separate GPU environment, exact CPU/cu126/cu130 manifests, driver selector, helper functions, rerunnable setup path, and settings activation only after a forced CUDA model+encode smoke. Three installer helper/integration tests pass; PowerShell scripts parse. Old-driver integration confirms `.env` remains CPU-selected.
- Task 4: complete — client updates runtime after worker fallback, health includes fileSearchRuntime, UI displays actual CPU/GPU and fallback. RED tests identified absent fields/stale device; focused client tests and build pass.
- Task 5: automated checks now passed after speech work: root 7, bridge 70, speech 10, file search 31; production builds passed. CPU-only/RTX device acceptance remains open for a normal Windows laptop.

Ruling: Preserve the CPU venv and provision a separate `.voicepilot-file-search\\venv-gpu`; activate it only after a forced CUDA FP32 model load and encode pass. This protects current CPU setup at the cost of additional disk usage.
Ruling: Select CUDA 12.6 for drivers 525–579 and CUDA 13.0 for driver 580+; require CUDA 13 for RTX 50-series. This supports older RTX drivers while selecting a newer build for recent RTX hardware; the smoke check is authoritative for exact laptop compatibility.

## Speech GPU plan

- Task 1: complete — STT auto/cpu/cuda selection, startup CUDA→CPU fallback in auto mode, explicit-CUDA failure, device metadata, and DLL registration; 10 speech tests pass.
- Task 2: implementation complete — isolated `.voicepilot-speech\\venv-gpu`, pinned Windows NVIDIA packages (CUDA 12.8, cuDNN 9.8.0.87, CTranslate2 4.6.3), model smoke before `.env` activation, and old-driver preservation integration test. PowerShell parse passes. Real package/model download remains unverified on target GPU laptop.
- Task 3: complete — STT worker gets runtime paths via child-only PATH, active metadata clears on exit, and tests prove parent PATH is unchanged.
- Task 4: complete — health contract/helper and setup-panel device label added; diagnostics report missing adapter/driver cleanly and include active bridge runtime when reachable. Local diagnostic executed; CIM access is restricted, `nvidia-smi` absent, bridge unavailable.
- Task 5: automated validation complete — full tests pass (root 7, bridge 70, speech 10, file search 31) and production builds pass. CPU audio/device check and real RTX large-v3 transcription/latency benchmark remain manual acceptance gates.
