import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from services.file_search.index import FileSearchIndex

tempfile.tempdir = str(Path(__file__).absolute().parents[2] / ".tmp")
Path(tempfile.tempdir).mkdir(parents=True, exist_ok=True)


class FakeCollection:
    def __init__(self):
        self.records = {}
        self.deleted = []
        self.queries = []

    def count(self):
        return len(self.records)

    def delete(self, *, where=None, ids=None):
        if ids:
            for item in ids:
                self.records.pop(item, None)
            return
        for item, record in list(self.records.items()):
            if all(record["metadata"].get(key) == value for key, value in (where or {}).items()):
                self.records.pop(item, None)
        self.deleted.append(where)

    def upsert(self, *, ids, embeddings, documents, metadatas):
        for item, embedding, document, metadata in zip(ids, embeddings, documents, metadatas):
            self.records[item] = {"embedding": embedding, "document": document, "metadata": metadata}

    def query(self, *, query_embeddings, n_results, include, where=None):
        self.queries.append({"query_embeddings": query_embeddings, "where": where, "n_results": n_results})
        records = list(self.records.items())[:n_results]
        return {
            "ids": [[item for item, _ in records]],
            "documents": [[record["document"] for _, record in records]],
            "metadatas": [[record["metadata"] for _, record in records]],
            "distances": [[0.2 for _ in records]],
        }


class FakeEmbedder:
    def __init__(self):
        self.calls = []
        self.fail = False

    def encode(self, texts, *, prompt_name):
        self.calls.append((list(texts), prompt_name))
        if self.fail:
            raise RuntimeError("synthetic embedding failure")
        return [[float(index + 1), 0.0, 0.0] for index, _ in enumerate(texts)]


class FileSearchIndexTests(unittest.TestCase):
    def setUp(self):
        # The managed sandbox denies Win32 realpath. These unit tests preserve
        # existence checks and lexical normalization; real Windows acceptance
        # still exercises native symlink/junction resolution.
        def sandbox_resolve(path, strict=False):
            resolved = Path(os.path.abspath(os.fspath(path)))
            if strict and not resolved.exists():
                raise FileNotFoundError(os.fspath(path))
            return resolved

        self.resolve_patch = patch.object(Path, "resolve", sandbox_resolve)
        self.resolve_patch.start()
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "docs"
        self.root.mkdir()
        self.collection = FakeCollection()
        self.embedder = FakeEmbedder()
        self.opened = []
        self.service = FileSearchIndex(
            self.base / "index.sqlite3", self.collection, self.embedder,
            open_file=self.opened.append,
        )

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()
        self.resolve_patch.stop()

    def test_indexes_selected_root_and_skips_unchanged_files(self):
        (self.root / "notes.md").write_text("alpha beta information", encoding="utf-8")
        root_id = self.service.add_root(str(self.root))
        first = self.service.index_root(root_id)
        calls_after_first = len(self.embedder.calls)
        second = self.service.index_root(root_id)
        self.assertEqual(first["indexed"], 1)
        self.assertEqual(second["unchanged"], 1)
        self.assertEqual(len(self.embedder.calls), calls_after_first)
        self.assertTrue(self.collection.records)

    def test_changed_file_replaces_chunks_and_deleted_file_drops_stale_chunks(self):
        file_path = self.root / "notes.txt"
        file_path.write_text("old content", encoding="utf-8")
        root_id = self.service.add_root(str(self.root))
        self.service.index_root(root_id)
        old_documents = {key: record["document"] for key, record in self.collection.records.items()}
        file_path.write_text("new content with a longer section", encoding="utf-8")
        changed = self.service.index_root(root_id)
        self.assertEqual(changed["indexed"], 1)
        self.assertTrue(any(self.collection.records[key]["document"] != document for key, document in old_documents.items()))
        file_path.unlink()
        stale = self.service.index_root(root_id)
        self.assertEqual(stale["removed"], 1)
        self.assertFalse(self.collection.records)

    def test_failed_reindex_preserves_previous_good_vectors(self):
        file_path = self.root / "notes.txt"
        file_path.write_text("previous searchable content", encoding="utf-8")
        root_id = self.service.add_root(str(self.root))
        self.service.index_root(root_id)
        previous = {key: record.copy() for key, record in self.collection.records.items()}

        file_path.write_text("updated content that cannot be embedded", encoding="utf-8")
        self.embedder.fail = True
        outcome = self.service.index_root(root_id)

        self.assertEqual(outcome["failed"], 1)
        self.assertEqual(self.collection.records, previous)

    def test_search_uses_search_query_prompt_and_returns_an_opaque_id(self):
        (self.root / "plans.md").write_text("project launch checklist", encoding="utf-8")
        root_id = self.service.add_root(str(self.root))
        self.service.index_root(root_id)
        result = self.service.search("how do I launch the project?", 1)[0]
        self.assertEqual(self.embedder.calls[-1][1], "SearchQuery")
        self.assertIsNone(self.embedder.calls[0][1])
        self.assertEqual(result["fileName"], "plans.md")
        self.assertTrue(result["resultId"].startswith("result_"))
        self.assertNotIn("canonical_path", result)
        self.assertNotIn("path", result)
        self.assertGreaterEqual(result["score"], 0)
        self.assertLessEqual(result["score"], 1)

    def test_open_requires_recent_result_id_and_rechecks_approved_root(self):
        file_path = self.root / "notes.txt"
        file_path.write_text("open me", encoding="utf-8")
        root_id = self.service.add_root(str(self.root))
        self.service.index_root(root_id)
        result = self.service.search("open me", 1)[0]
        self.service.open_result(result["resultId"])
        self.assertEqual(self.opened, [file_path.resolve()])
        with self.assertRaises(ValueError):
            self.service.open_result(str(file_path))

    def test_result_id_is_invalidated_when_its_root_is_removed(self):
        (self.root / "notes.txt").write_text("find this", encoding="utf-8")
        root_id = self.service.add_root(str(self.root))
        self.service.index_root(root_id)
        result = self.service.search("find", 1)[0]
        self.service.remove_root(root_id)
        with self.assertRaises(ValueError):
            self.service.open_result(result["resultId"])


class EmbedderDeviceTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

    def load_embedder(self, preference, cuda_available, failures=None, encode_failures=None):
        failures = failures or {}
        encode_failures = encode_failures or {}
        torch = types.ModuleType("torch")
        torch.float32 = "TORCH_FLOAT32_FIXTURE"
        torch.cuda = types.SimpleNamespace(is_available=lambda: cuda_available)

        sentence_transformers = types.ModuleType("sentence_transformers")

        class FakeSentenceTransformer:
            def __init__(inner_self, model_id, *, device, model_kwargs, config_kwargs):
                self.calls.append({
                    "model_id": model_id,
                    "device": device,
                    "model_kwargs": model_kwargs,
                    "config_kwargs": config_kwargs,
                })
                if device in failures:
                    raise failures[device]
                inner_self.device = device

            def encode(inner_self, texts, **options):
                if inner_self.device in encode_failures:
                    raise encode_failures[inner_self.device]
                return [[1.0] for _ in texts]

        sentence_transformers.SentenceTransformer = FakeSentenceTransformer
        with patch.dict("sys.modules", {"torch": torch, "sentence_transformers": sentence_transformers}):
            from services.file_search.index import SentenceTransformerEmbedder
            return SentenceTransformerEmbedder(device_preference=preference)

    def test_cpu_preference_never_attempts_cuda_and_preserves_fp32(self):
        embedder = self.load_embedder("cpu", True)
        self.assertEqual(embedder.active_device, "cpu")
        self.assertEqual([call["device"] for call in self.calls], ["cpu"])
        self.assertEqual(self.calls[0]["model_kwargs"]["torch_dtype"], "TORCH_FLOAT32_FIXTURE")
        self.assertEqual(embedder.fallback_reason, None)

    def test_auto_uses_cuda_when_available_and_keeps_fp32(self):
        embedder = self.load_embedder("auto", True)
        self.assertEqual(embedder.active_device, "cuda")
        self.assertEqual([call["device"] for call in self.calls], ["cuda"])
        self.assertIs(embedder.model.device, "cuda")
        self.assertEqual(self.calls[0]["model_kwargs"]["torch_dtype"], "TORCH_FLOAT32_FIXTURE")

    def test_auto_without_cuda_uses_cpu_and_explains_fallback(self):
        embedder = self.load_embedder("auto", False)
        self.assertEqual(embedder.active_device, "cpu")
        self.assertIn("CUDA", embedder.fallback_reason)
        self.assertEqual([call["device"] for call in self.calls], ["cpu"])

    def test_auto_cuda_load_error_retries_cpu_once_and_keeps_error(self):
        embedder = self.load_embedder("auto", True, {"cuda": RuntimeError("out of VRAM")})
        self.assertEqual(embedder.active_device, "cpu")
        self.assertIn("out of VRAM", embedder.fallback_reason)
        self.assertEqual([call["device"] for call in self.calls], ["cuda", "cpu"])

    def test_auto_cuda_embedding_error_moves_model_to_cpu_and_retries_once(self):
        embedder = self.load_embedder(
            "auto", True, encode_failures={"cuda": RuntimeError("CUDA out of memory")}
        )
        result = embedder.encode(["query"], prompt_name="SearchQuery")
        self.assertEqual(result, [[1.0]])
        self.assertEqual(embedder.active_device, "cpu")
        self.assertIn("CUDA out of memory", embedder.fallback_reason)
        self.assertEqual([call["device"] for call in self.calls], ["cuda", "cpu"])

    def test_explicit_cuda_unavailable_fails_without_cpu_fallback(self):
        with self.assertRaisesRegex(RuntimeError, "CUDA"):
            self.load_embedder("cuda", False)
        self.assertEqual(self.calls, [])

    def test_invalid_preference_fails_before_model_load(self):
        for preference in ("gpu", ""):
            with self.subTest(preference=preference), self.assertRaisesRegex(ValueError, "auto, cpu, or cuda"):
                self.load_embedder(preference, False)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
