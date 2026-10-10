# VoicePilot GPU Acceleration Design

**Status:** Approved for implementation planning and execution (user: “continue”)  
**Date:** 2026-10-11

## Goal

Allow VoicePilot’s local speech recognition and semantic file search to use a supported NVIDIA GPU on Windows, while retaining a usable CPU path on laptops without a compatible GPU. Keep the embedding model in FP32 as requested.

## Current state

- File search runs in its own Python environment and pins CPU-only PyTorch. `SentenceTransformerEmbedder` explicitly selects `device="cpu"` and `torch.float32`.
- Speech recognition runs in a separate Python environment with faster-whisper. Its worker reads `VOICEPILOT_STT_DEVICE` (default `auto`) and compute type, but the installer does not provision the Windows CUDA/cuDNN libraries needed for GPU inference.
- Bridge health reports model/service state but does not consistently tell the UI which execution device was actually loaded.
- Installers are expected to work on other Windows 11 laptops, including CPU-only machines.

## Proposed behavior

### Device preference and selection

- File search accepts `auto`, `cpu`, or `cuda`; default is `auto`.
- Speech retains `auto`, `cpu`, or `cuda`; default is `auto`.
- `auto` prefers CUDA only when the NVIDIA driver, installed runtime, and model backend are usable. Otherwise it loads on CPU and reports why CUDA was not selected.
- `cpu` always selects CPU. `cuda` is an explicit request: fail service startup with an actionable diagnostic if CUDA is not available, rather than silently claiming GPU operation.
- If automatic CUDA initialization or model allocation fails, release partial model state where possible and attempt CPU once. Report the actual device and the CUDA failure reason. Do not loop or repeatedly reload model weights after a failed startup; the bridge restart remains the recovery boundary for a latched worker startup failure.
- EmbeddingGemma remains FP32 on both devices. GPU use changes the execution device, not the model dtype.

### Windows installation

- Keep CPU-only installation as the baseline and fallback. Installation must not require an NVIDIA GPU or administrator rights.
- Detect NVIDIA hardware/driver on setup and expose an explicit GPU-capable setup option. The option installs a CUDA-enabled PyTorch build for the isolated file-search environment and the pinned, compatible CUDA/cuDNN runtime required by the isolated faster-whisper environment.
- Select CUDA wheel/runtime variants based on verified compatibility with the installed NVIDIA driver and the project’s pinned Python, PyTorch, torchvision, and CTranslate2 versions. Pin the chosen package versions; avoid unbounded latest-version downloads. If the driver is absent/too old or package/runtime installation fails, preserve the CPU setup and give a specific remediation message.
- Do not install, update, or replace NVIDIA display drivers. The laptop owner installs drivers from NVIDIA. Do not change global Python packages; keep dependencies in VoicePilot’s existing per-service virtual environments.
- Make the faster-whisper CUDA libraries discoverable by the worker process using a scoped process environment, not a permanent system PATH edit.
- Provide an idempotent setup/repair path so users can rerun GPU provisioning after installing/updating the NVIDIA driver.

### Diagnostics and UI

- Add a GPU diagnostic command that reports: NVIDIA adapter/driver discovery, driver compatibility result, Python and package versions, PyTorch CUDA build/runtime availability, CTranslate2/CUDA/cuDNN availability, each service’s requested preference, and each service’s active device.
- Extend the bridge health response for STT and file search with the active device, execution backend, and a concise fallback/initialization reason where applicable. Retain current fields so the UI’s existing health display remains compatible.
- Show `CPU` or `NVIDIA GPU` next to the loaded model in setup/status UI. When automatic mode falls back, show the specific reason and a link/instruction to run diagnostics. Do not describe a service as GPU-ready merely because a GPU was detected; report GPU active only after that model backend actually loads on CUDA.

## Failure handling

- Missing NVIDIA GPU or driver in `auto`: continue on CPU and identify the prerequisite in diagnostics.
- Old/incompatible driver or absent CUDA/cuDNN libraries in `auto`: attempt CPU and report the failed GPU prerequisite.
- CUDA out-of-memory or model initialization error in `auto`: clean up and retry once on CPU; if CPU also fails, surface both concise errors and keep the worker failure latched until bridge restart.
- Any unavailable CUDA prerequisite in explicit `cuda`: fail with instructions to install/update the NVIDIA driver and rerun VoicePilot GPU setup/diagnostics.
- Network/package download failure during optional GPU provisioning: retain the already installed CPU environment and explain that GPU setup can be retried. Do not leave the app in a partially upgraded, unlaunchable state.

## Scope and non-goals

Included: EmbeddingGemma file-search inference, faster-whisper STT inference, Windows setup/repair, diagnostics, health reporting, and concise UI device status.

Not included in this iteration: AMD or Intel GPU backends; installing/updating device drivers; accelerating the local chat LLM or Piper TTS; changing EmbeddingGemma from FP32; promising CUDA use on an unverified GPU/driver combination.

## Verification and acceptance

1. Unit tests cover preference parsing, auto/CPU/CUDA selection, explicit-CUDA errors, CUDA-to-CPU fallback, reporting of actual device, and preservation of FP32 embeddings.
2. Installer checks cover CPU-only Windows, supported NVIDIA/driver detection, rerunnable GPU setup, interrupted downloads, and absence of global PATH/package modifications.
3. Bridge/UI checks verify both services expose the actual device and a useful fallback explanation without breaking existing health consumers.
4. On a clean CPU-only Windows 11 laptop, the standard setup completes and both services can run on CPU.
5. On the user’s NVIDIA RTX laptop, GPU setup completes, diagnostics identify compatible components, and both models report CUDA as active only after successful model load and inference. Record GPU model, driver, VRAM, package/runtime versions, and observed result for reproducibility.
6. Manual target-laptop GPU verification is a release gate; automated tests alone cannot establish that CUDA works with the user’s installed driver and GPU.

## Design decisions still to pin during implementation planning

- File-search CUDA wheels are pinned to PyTorch 2.14.1 / torchvision 0.29.1. Use CUDA 12.6 for NVIDIA driver versions 525–579 and CUDA 13.0 for driver 580 or newer; RTX 50-series hardware requires CUDA 13.0.
- The distribution and integrity verification method for the Windows faster-whisper CUDA/cuDNN runtime must be fixed before downloading/installing it. The setup should pin a release and verify its published checksum/signature where available; otherwise report the trust and update implications clearly.
- The current user only identified the other machine as “NVIDIA GeForce / RTX”; its exact adapter, driver version, and VRAM remain unknown and will be collected by diagnostics on that laptop.
