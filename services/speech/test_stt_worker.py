"""Offline tests for the STT worker protocol; no model files or audio device needed."""

from __future__ import annotations

import io
import json
import os
import sys
import types
import unittest
from unittest.mock import patch

import stt_worker


class FakeSegment:
    text = " Open Notepad. "


class FakeInfo:
    language = "en"
    language_probability = 0.98


class FakeModel:
    def __init__(self, model_name: str, *, device: str, compute_type: str) -> None:
        if model_name == "large-v3":
            raise RuntimeError("mkl_malloc: failed to allocate memory")
        self.config = (model_name, device, compute_type)

    def transcribe(self, audio_path: str, **kwargs: object):
        assert audio_path == "sample.webm"
        assert kwargs["vad_filter"] is True
        return [FakeSegment()], FakeInfo()


class SttWorkerTests(unittest.TestCase):
    def test_cuda_runtime_directories_are_registered_before_native_imports(self) -> None:
        handles: list[str] = []

        def add_directory(path: str) -> str:
            handles.append(path)
            return path

        with patch.object(stt_worker.os, "name", "nt"), patch.object(stt_worker.os, "pathsep", ";"), patch.object(stt_worker.os, "add_dll_directory", add_directory, create=True), \
                patch.object(stt_worker.os.path, "isdir", return_value=True), patch.dict(os.environ, {"VOICEPILOT_STT_CUDA_RUNTIME": "cuda-bin;cudnn-bin"}):
            stt_worker._CUDA_DLL_HANDLES.clear()
            stt_worker.prepare_cuda_runtime()
            self.assertEqual(handles, ["cuda-bin", "cudnn-bin"])
            self.assertEqual(stt_worker._CUDA_DLL_HANDLES, handles)
            stt_worker._CUDA_DLL_HANDLES.clear()

    def run_worker(
        self,
        input_text: str,
        provider: str = "faster-whisper",
        model: str = "fixture-model",
        fallback: str = "base",
        device: str = "cpu",
        cuda_types: set[str] | None = None,
        model_errors: dict[tuple[str, str], Exception] | None = None,
    ) -> tuple[int, list[dict[str, object]]]:
        fake_module = types.ModuleType("faster_whisper")
        self.model_calls: list[tuple[str, str, str]] = []
        model_errors = model_errors or {}

        def fake_whisper_model(model_name: str, *, device: str, compute_type: str):
            self.model_calls.append((model_name, device, compute_type))
            error = model_errors.get((model_name, device))
            if error:
                raise error
            return FakeModel(model_name, device=device, compute_type=compute_type)

        fake_module.WhisperModel = fake_whisper_model  # type: ignore[attr-defined]
        fake_ctranslate = types.ModuleType("ctranslate2")
        fake_ctranslate.get_supported_compute_types = lambda requested_device: (  # type: ignore[attr-defined]
            set(cuda_types or ()) if requested_device == "cuda" else {"int8", "float32"}
        )
        stdout = io.StringIO()
        env = {
            "VOICEPILOT_STT_PROVIDER": provider,
            "VOICEPILOT_STT_MODEL": model,
            "VOICEPILOT_STT_FALLBACK_MODEL": fallback,
            "VOICEPILOT_STT_DEVICE": device,
            "VOICEPILOT_STT_COMPUTE_TYPE": "int8",
        }
        with patch.dict(os.environ, env), patch.dict(sys.modules, {"faster_whisper": fake_module, "ctranslate2": fake_ctranslate}), \
                patch("sys.stdin", io.StringIO(input_text)), patch("sys.stdout", stdout):
            exit_code = stt_worker.main()
        records = [json.loads(line) for line in stdout.getvalue().splitlines()]
        return exit_code, records

    def test_loads_model_and_transcribes_jsonl_request(self) -> None:
        exit_code, records = self.run_worker('{"id":"request-1","audioPath":"sample.webm"}\n')
        self.assertEqual(exit_code, 0)
        self.assertEqual([record["type"] for record in records[:2]], ["status", "ready"])
        self.assertEqual(records[2]["id"], "request-1")
        self.assertEqual(records[2]["text"], "Open Notepad.")
        self.assertEqual(records[2]["language"], "en")
        self.assertEqual(records[1]["device"], "cpu")
        self.assertEqual(records[2]["device"], "cpu")
        self.assertTrue(records[2]["ok"])

    def test_auto_selects_cuda_when_ctranslate2_supports_it(self) -> None:
        exit_code, records = self.run_worker("", device="auto", cuda_types={"float16", "int8_float16"})
        ready = next(record for record in records if record.get("type") == "ready")
        self.assertEqual(exit_code, 0)
        self.assertEqual(self.model_calls, [("fixture-model", "cuda", "int8")])
        self.assertEqual(ready["device"], "cuda")
        self.assertEqual(ready["devicePreference"], "auto")
        self.assertEqual(ready["backend"], "ctranslate2")
        self.assertIsNone(ready["fallbackReason"])

    def test_auto_selects_cpu_with_reason_when_ctranslate2_has_no_cuda(self) -> None:
        exit_code, records = self.run_worker("", device="auto", cuda_types=set())
        ready = next(record for record in records if record.get("type") == "ready")
        self.assertEqual(exit_code, 0)
        self.assertEqual(self.model_calls, [("fixture-model", "cpu", "int8")])
        self.assertEqual(ready["device"], "cpu")
        self.assertIn("CUDA", str(ready["fallbackReason"]))

    def test_auto_retries_model_on_cpu_after_cuda_startup_error(self) -> None:
        exit_code, records = self.run_worker(
            "", device="auto", cuda_types={"float16"},
            model_errors={("fixture-model", "cuda"): RuntimeError("CUDA driver initialization failed")},
        )
        ready = next(record for record in records if record.get("type") == "ready")
        self.assertEqual(exit_code, 0)
        self.assertEqual(self.model_calls, [("fixture-model", "cuda", "int8"), ("fixture-model", "cpu", "int8")])
        self.assertEqual(ready["device"], "cpu")
        self.assertIn("CUDA driver initialization failed", str(ready["fallbackReason"]))

    def test_explicit_cuda_without_ctranslate2_support_fails_before_model_load(self) -> None:
        exit_code, records = self.run_worker("", device="cuda", cuda_types=set())
        self.assertEqual(exit_code, 2)
        self.assertEqual(records[0]["type"], "startup_error")
        self.assertIn("CUDA", str(records[0]["error"]))
        self.assertEqual(self.model_calls, [])

    def test_explicit_cuda_model_error_does_not_retry_on_cpu(self) -> None:
        exit_code, records = self.run_worker(
            "", device="cuda", cuda_types={"float16"},
            model_errors={("fixture-model", "cuda"): RuntimeError("CUDA runtime missing")},
        )
        self.assertEqual(exit_code, 2)
        self.assertEqual(records[-1]["type"], "startup_error")
        self.assertEqual(self.model_calls, [("fixture-model", "cuda", "int8")])

    def test_reports_malformed_and_non_object_requests_without_crashing(self) -> None:
        exit_code, records = self.run_worker('not-json\n[]\n')
        self.assertEqual(exit_code, 0)
        self.assertEqual(records[-2]["ok"], False)
        self.assertEqual(records[-1]["ok"], False)

    def test_rejects_unsupported_provider_before_loading_model(self) -> None:
        exit_code, records = self.run_worker("", provider="ark")
        self.assertEqual(exit_code, 2)
        self.assertEqual(records[0]["type"], "startup_error")
        self.assertIn("Unsupported", str(records[0]["error"]))

    def test_falls_back_to_base_model_after_memory_allocation_failure(self) -> None:
        exit_code, records = self.run_worker(
            '{"id":"request-fallback","audioPath":"sample.webm"}\n',
            model="large-v3",
        )
        ready = next(record for record in records if record.get("type") == "ready")
        result = next(record for record in records if record.get("id") == "request-fallback")
        self.assertEqual(exit_code, 0)
        self.assertEqual(ready["model"], "base")
        self.assertEqual(ready["fallbackFrom"], "large-v3")
        self.assertEqual(result["model"], "base")


if __name__ == "__main__":
    unittest.main()
