"""Long-lived local STT worker. stdout is a JSON-lines protocol; logs go to stderr."""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any


_CUDA_DLL_HANDLES: list[Any] = []


def prepare_cuda_runtime() -> None:
    """Register optional, environment-scoped CUDA DLL directories before native imports."""
    if os.name != "nt":
        return
    runtime = os.environ.get("VOICEPILOT_STT_CUDA_RUNTIME", "")
    add_directory = getattr(os, "add_dll_directory", None)
    if not runtime or add_directory is None:
        return
    for directory in runtime.split(os.pathsep):
        if directory and os.path.isdir(directory):
            _CUDA_DLL_HANDLES.append(add_directory(directory))


def emit(record: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    provider = os.environ.get("VOICEPILOT_STT_PROVIDER", "faster-whisper")
    if provider != "faster-whisper":
        emit({"type": "startup_error", "error": f"Unsupported STT provider: {provider}"})
        return 2

    model_name = os.environ.get("VOICEPILOT_STT_MODEL", "large-v3")
    fallback_model = os.environ.get("VOICEPILOT_STT_FALLBACK_MODEL", "base").strip()
    device_preference = os.environ.get("VOICEPILOT_STT_DEVICE", "auto")
    compute_type = os.environ.get("VOICEPILOT_STT_COMPUTE_TYPE", "default")
    if device_preference not in {"auto", "cpu", "cuda"}:
        emit({"type": "startup_error", "error": "Speech device must be auto, cpu, or cuda."})
        return 2
    prepare_cuda_runtime()
    try:
        from faster_whisper import WhisperModel
        import ctranslate2
    except Exception as error:
        emit({"type": "startup_error", "error": f"faster-whisper/CTranslate2 is unavailable: {type(error).__name__}: {error}"})
        return 2

    cuda_types: set[str] = set()
    cuda_check_error: Exception | None = None
    if device_preference != "cpu":
        try:
            cuda_types = set(ctranslate2.get_supported_compute_types("cuda"))
        except Exception as error:
            cuda_check_error = error
    if device_preference == "cuda" and not cuda_types:
        detail = f" ({type(cuda_check_error).__name__}: {cuda_check_error})" if cuda_check_error else ""
        emit({
            "type": "startup_error",
            "error": "CUDA was requested for speech, but CTranslate2 cannot access a supported NVIDIA CUDA runtime" + detail + ". "
            "Install a compatible NVIDIA driver, run npm run setup:speech:gpu, and run npm run diagnose:gpu.",
        })
        return 2

    device = "cuda" if (device_preference == "cuda" or (device_preference == "auto" and cuda_types)) else "cpu"
    fallback_reason = None
    if device_preference == "auto" and device == "cpu":
        detail = f" ({type(cuda_check_error).__name__}: {cuda_check_error})" if cuda_check_error else ""
        fallback_reason = "CTranslate2 reports no supported CUDA compute types" + detail + "; using CPU."

    emit({"type": "status", "status": "loading_model", "provider": provider, "model": model_name,
          "device": device, "devicePreference": device_preference})

    def load_model(name: str, target_device: str):
        return WhisperModel(name, device=target_device, compute_type=compute_type)

    def is_memory_error(error: Exception) -> bool:
        message = str(error).lower()
        return isinstance(error, MemoryError) or (
            "memory" in message
            and any(marker in message for marker in ("allocat", "mkl_malloc", "paging file", "out of memory"))
        )

    try:
        model = load_model(model_name, device)
        active_model = model_name
        fallback_from = None
    except Exception as error:
        if device_preference == "auto" and device == "cuda":
            fallback_reason = f"CUDA model startup failed ({type(error).__name__}: {error}); using CPU."
            try:
                model = load_model(model_name, "cpu")
                device = "cpu"
                active_model = model_name
                fallback_from = None
            except Exception as cpu_error:
                if not fallback_model or fallback_model == model_name or not is_memory_error(cpu_error):
                    emit({
                        "type": "startup_error",
                        "error": f"CUDA model startup failed ({type(error).__name__}: {error}); CPU retry also failed: "
                        f"{type(cpu_error).__name__}: {cpu_error}",
                    })
                    return 2
                emit({"type": "status", "status": "loading_fallback", "provider": provider,
                      "model": fallback_model, "fallbackFrom": model_name, "device": "cpu"})
                try:
                    model = load_model(fallback_model, "cpu")
                    device = "cpu"
                    active_model = fallback_model
                    fallback_from = model_name
                except Exception as fallback_error:
                    emit({"type": "startup_error", "error": f"CUDA model startup failed ({error}); CPU {model_name} retry failed ({cpu_error}); CPU fallback {fallback_model} also failed: {type(fallback_error).__name__}: {fallback_error}"})
                    return 2
        elif not fallback_model or fallback_model == model_name or not is_memory_error(error):
            emit({
                "type": "startup_error",
                "error": f"Could not load STT model {model_name}: {type(error).__name__}: {error}",
            })
            return 2
        else:
            emit({"type": "status", "status": "loading_fallback", "provider": provider,
                  "model": fallback_model, "fallbackFrom": model_name, "device": device})
            try:
                model = load_model(fallback_model, device)
                active_model = fallback_model
                fallback_from = model_name
            except Exception as fallback_error:
                emit({
                    "type": "startup_error",
                    "error": f"Primary model {model_name} ran out of memory ({error}); fallback {fallback_model} also failed: {type(fallback_error).__name__}: {fallback_error}",
                })
                return 2
    active_device = device
    emit({"type": "ready", "provider": provider, "model": active_model, "requestedModel": model_name,
          "fallbackFrom": fallback_from, "device": active_device, "devicePreference": device_preference,
          "backend": "ctranslate2", "fallbackReason": fallback_reason})
    for line in sys.stdin:
        request: Any = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Each request must be a JSON object.")
            request_id = request.get("id")
            audio_path = request.get("audioPath")
            if not isinstance(request_id, str) or not isinstance(audio_path, str):
                raise ValueError("Each request needs a string id and audioPath.")
            started = time.perf_counter()
            segments, info = model.transcribe(
                audio_path,
                beam_size=5,
                vad_filter=True,
                without_timestamps=True,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            emit({
                "id": request_id,
                "ok": True,
                "text": text,
                "language": info.language,
                "languageProbability": info.language_probability,
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "provider": provider,
                "model": active_model,
                "device": active_device,
            })
        except Exception as error:
            emit({
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
