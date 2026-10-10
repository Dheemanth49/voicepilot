"""Persistent JSONL service for local, approved-root semantic file search."""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

from .index import FileSearchIndex, SentenceTransformerEmbedder, create_chroma_collection


def dispatch(service: FileSearchIndex, request: dict) -> dict:
    request_id = request.get("id") if isinstance(request, dict) else None
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
        return {"id": request_id if isinstance(request_id, str) else "", "ok": False, "error": "A valid request ID is required."}
    if not isinstance(request, dict):
        return {"id": request_id, "ok": False, "error": "Request must be a JSON object."}
    action = request.get("action")
    try:
        if action == "status":
            response = {"ready": True, **_runtime_fields(service), "roots": service.list_roots()}
        elif action == "roots_list":
            response = {"roots": service.list_roots()}
        elif action == "root_add":
            path = request.get("path")
            if not isinstance(path, str) or not path.strip():
                raise ValueError("An existing folder path is required.")
            response = {"rootId": service.add_root(path)}
        elif action == "root_remove":
            root_id = _required_string(request, "rootId", 100)
            service.remove_root(root_id)
            response = {"removed": True}
        elif action == "root_index":
            root_id = _required_string(request, "rootId", 100)
            response = service.index_root(root_id)
        elif action == "search":
            query = _required_string(request, "query", 1000)
            limit = request.get("limit", 5)
            if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 10:
                raise ValueError("Search result limit must be from 1 to 10.")
            response = {"results": service.search(query, limit)}
        elif action == "open_file":
            result_id = _required_string(request, "resultId", 100)
            response = service.open_result(result_id)
        else:
            raise ValueError("Unsupported file-search operation.")
        return {"id": request_id, "ok": True, **response}
    except (ValueError, OSError, RuntimeError) as error:
        return {"id": request_id, "ok": False, "error": str(error)}
    except Exception as error:
        print(f"[VoicePilot file search] {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return {"id": request_id, "ok": False, "error": "The local file-search operation failed."}


def _required_string(request: dict, key: str, maximum: int) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{key} must be a non-empty string of at most {maximum} characters.")
    return value.strip()


def create_service() -> FileSearchIndex:
    repo_root = Path(__file__).absolute().parents[2]
    default_data_root = Path(os.environ.get("APPDATA", str(Path.home()))) / "VoicePilot"
    data_root = Path(os.environ.get("VOICEPILOT_DATA_DIR", str(default_data_root)))
    data_root.mkdir(parents=True, exist_ok=True)
    model_id = os.environ.get("VOICEPILOT_FILE_SEARCH_MODEL", "google/embeddinggemma-2")
    if model_id != "google/embeddinggemma-2":
        raise ValueError("Only the configured google/embeddinggemma-2 model is supported.")
    return FileSearchIndex(
        data_root / "file-search.sqlite3",
        create_chroma_collection(data_root / "chroma"),
        SentenceTransformerEmbedder(
            model_id,
            device_preference=os.environ.get("VOICEPILOT_FILE_SEARCH_DEVICE", "auto"),
        ),
    )


def _runtime_fields(service: FileSearchIndex) -> dict:
    embedder = service.embedder
    return {
        "model": "google/embeddinggemma-2",
        "device": embedder.active_device,
        "devicePreference": embedder.device_preference,
        "backend": "pytorch",
        "fallbackReason": embedder.fallback_reason,
        "dtype": "float32",
    }


def run_worker(service: FileSearchIndex | None = None):
    owned_service = service is None
    try:
        if service is None:
            service = create_service()
        _write({"type": "ready", **_runtime_fields(service)})
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("Request must be a JSON object.")
                previous_runtime = _runtime_fields(service)
                response = dispatch(service, request)
                current_runtime = _runtime_fields(service)
                if current_runtime != previous_runtime:
                    _write({"type": "runtime", **current_runtime})
            except (json.JSONDecodeError, ValueError) as error:
                response = {"id": "", "ok": False, "error": str(error)}
            _write(response)
    except Exception as error:
        print(f"[VoicePilot file search] {traceback.format_exc()}", file=sys.stderr, flush=True)
        _write({"type": "startup_error", "error": str(error)})
        return 1
    finally:
        if owned_service and service is not None:
            service.close()
    return 0


def _write(record: dict):
    sys.stdout.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(run_worker())
