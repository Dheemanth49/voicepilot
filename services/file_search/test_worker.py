import unittest
import io
import json
import types
from unittest.mock import patch

from services.file_search.worker import dispatch, run_worker


class FakeService:
    def __init__(self):
        self.calls = []
        self.embedder = types.SimpleNamespace(
            active_device="cuda",
            device_preference="auto",
            fallback_reason=None,
        )

    def list_roots(self):
        self.calls.append(("list_roots",))
        return [{"root_id": "root_a", "display_name": "Documents", "enabled": 1}]

    def add_root(self, path):
        self.calls.append(("add_root", path))
        return "root_a"

    def remove_root(self, root_id):
        self.calls.append(("remove_root", root_id))

    def index_root(self, root_id):
        self.calls.append(("index_root", root_id))
        return {"rootId": root_id, "indexed": 2, "unchanged": 0, "failed": 0, "removed": 0}

    def search(self, query, limit):
        self.calls.append(("search", query, limit))
        self.embedder.active_device = "cpu"
        self.embedder.fallback_reason = "CUDA embedding failed; using CPU."
        return [{"resultId": "result_a"}]

    def open_result(self, result_id):
        self.calls.append(("open_result", result_id))
        return {"opened": True}


class FileSearchWorkerTests(unittest.TestCase):
    def setUp(self):
        self.service = FakeService()

    def test_dispatch_preserves_request_id_and_calls_expected_operation(self):
        response = dispatch(self.service, {"id": "request-1", "action": "search", "query": "project notes", "limit": 4})
        self.assertEqual(response, {"id": "request-1", "ok": True, "results": [{"resultId": "result_a"}]})
        self.assertEqual(self.service.calls, [("search", "project notes", 4)])

    def test_dispatch_supports_approved_folder_lifecycle(self):
        self.assertEqual(dispatch(self.service, {"id": "1", "action": "roots_list"})["roots"][0]["root_id"], "root_a")
        self.assertEqual(dispatch(self.service, {"id": "2", "action": "root_add", "path": "C:/Docs"})["rootId"], "root_a")
        self.assertEqual(dispatch(self.service, {"id": "3", "action": "root_index", "rootId": "root_a"})["indexed"], 2)
        self.assertTrue(dispatch(self.service, {"id": "4", "action": "root_remove", "rootId": "root_a"})["ok"])
        self.assertEqual([call[0] for call in self.service.calls], ["list_roots", "add_root", "index_root", "remove_root"])

    def test_dispatch_open_uses_only_the_opaque_result_id(self):
        dispatch(self.service, {"id": "1", "action": "open_file", "resultId": "result_a"})
        self.assertEqual(self.service.calls, [("open_result", "result_a")])
        self.assertFalse(any("path" in key for key in {"id", "action", "resultId"}))

    def test_dispatch_rejects_unknown_or_malformed_requests(self):
        for request in ({}, {"id": "1", "action": "exec", "command": "whoami"},
                        {"id": "1", "action": "search", "query": "", "limit": 0}):
            with self.subTest(request=request):
                response = dispatch(self.service, request)
                self.assertFalse(response["ok"])
                self.assertIn("error", response)

    def test_status_includes_actual_model_runtime_fields(self):
        response = dispatch(self.service, {"id": "runtime-1", "action": "status"})
        self.assertEqual(response["device"], "cuda")
        self.assertEqual(response["devicePreference"], "auto")
        self.assertEqual(response["backend"], "pytorch")
        self.assertIsNone(response["fallbackReason"])
        self.assertEqual(response["dtype"], "float32")
        self.assertEqual(response["model"], "google/embeddinggemma-2")
        self.assertIn("roots", response)

    def test_worker_ready_event_reports_selected_device_and_fallback(self):
        self.service.embedder.active_device = "cpu"
        self.service.embedder.fallback_reason = "CUDA initialization failed; using CPU."
        output = io.StringIO()
        with patch("sys.stdin", io.StringIO("")), patch("sys.stdout", output):
            self.assertEqual(run_worker(self.service), 0)
        ready = json.loads(output.getvalue().splitlines()[0])
        self.assertEqual(ready["type"], "ready")
        self.assertEqual(ready["device"], "cpu")
        self.assertEqual(ready["devicePreference"], "auto")
        self.assertEqual(ready["backend"], "pytorch")
        self.assertEqual(ready["fallbackReason"], "CUDA initialization failed; using CPU.")
        self.assertEqual(ready["dtype"], "float32")

    def test_worker_emits_runtime_update_after_auto_fallback(self):
        output = io.StringIO()
        request = '{"id":"search-1","action":"search","query":"notes","limit":1}\n'
        with patch("sys.stdin", io.StringIO(request)), patch("sys.stdout", output):
            self.assertEqual(run_worker(self.service), 0)
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(records[0]["type"], "ready")
        self.assertEqual(records[1]["type"], "runtime")
        self.assertEqual(records[1]["device"], "cpu")
        self.assertEqual(records[1]["fallbackReason"], "CUDA embedding failed; using CPU.")
        self.assertEqual(records[2]["id"], "search-1")


if __name__ == "__main__":
    unittest.main()
