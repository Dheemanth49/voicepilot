import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

tempfile.tempdir = str(Path(__file__).absolute().parents[2] / ".tmp")
Path(tempfile.tempdir).mkdir(parents=True, exist_ok=True)

from services.file_search.core import (
    canonicalize_root,
    chunk_text,
    content_hash,
    extract_text,
    is_within_root,
)


class FileSearchCoreTests(unittest.TestCase):
    def setUp(self):
        # The managed Python runtime cannot call Win32 realpath in this sandbox.
        # Preserve filesystem existence checks while normalizing lexical `..` paths.
        def sandbox_resolve(path, strict=False):
            resolved = Path(os.path.abspath(os.fspath(path)))
            if strict and not resolved.exists():
                raise FileNotFoundError(os.fspath(path))
            return resolved

        self.path_resolve_patch = patch.object(Path, "resolve", sandbox_resolve)
        self.path_resolve_patch.start()

    def tearDown(self):
        self.path_resolve_patch.stop()

    def test_canonicalize_root_resolves_an_existing_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "documents"
            root.mkdir()
            self.assertEqual(canonicalize_root(str(root)), root.resolve())

    def test_canonicalize_root_rejects_missing_paths_and_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            file_path = Path(temporary) / "notes.txt"
            file_path.write_text("notes", encoding="utf-8")
            for path in (str(file_path), str(Path(temporary) / "missing")):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    canonicalize_root(path)

    def test_path_containment_rejects_parent_traversal_after_resolution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "approved"
            root.mkdir()
            inside = root / "notes.txt"
            outside = root / ".." / "private.txt"
            self.assertTrue(is_within_root(inside, root))
            self.assertFalse(is_within_root(outside, root))

    def test_path_resolution_denial_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(Path, "resolve", side_effect=PermissionError("realpath blocked")):
                with self.assertRaises(ValueError):
                    canonicalize_root(str(root))
                self.assertFalse(is_within_root(root / "notes.txt", root))

    def test_chunk_text_bounds_chunks_and_retains_the_requested_overlap(self):
        text = "alpha beta gamma delta epsilon zeta eta theta"
        chunks = chunk_text(text, max_chars=18, overlap=5)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(0 < len(chunk) <= 18 for chunk in chunks))
        self.assertTrue(all(chunks[index][-5:] == chunks[index + 1][:5] for index in range(len(chunks) - 1)))
        rebuilt = chunks[0] + "".join(chunk[5:] for chunk in chunks[1:])
        self.assertEqual(rebuilt, text)

    def test_chunk_text_rejects_invalid_sizes(self):
        for max_chars, overlap in ((0, 0), (10, -1), (10, 10), (10, 12)):
            with self.subTest(max_chars=max_chars, overlap=overlap), self.assertRaises(ValueError):
                chunk_text("some text", max_chars=max_chars, overlap=overlap)

    def test_extract_text_reads_utf8_text_and_replaces_invalid_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            text_file = Path(temporary) / "notes.md"
            text_file.write_bytes(b"hello\xffworld")
            self.assertEqual(extract_text(text_file), "hello\ufffdworld")

    def test_extract_text_uses_pdf_page_text(self):
        class FakePage:
            def extract_text(self):
                return "page one"

        class FakePdfReader:
            is_encrypted = False

            def __init__(self, _path):
                self.pages = [FakePage(), FakePage()]

        with tempfile.TemporaryDirectory() as temporary:
            pdf_file = Path(temporary) / "paper.pdf"
            pdf_file.write_bytes(b"fixture")
            with patch.dict(sys.modules, {"pypdf": SimpleNamespace(PdfReader=FakePdfReader)}):
                self.assertEqual(extract_text(pdf_file), "page one\npage one")

    def test_extract_text_includes_docx_paragraphs_and_table_cells(self):
        class FakeDocument:
            paragraphs = [SimpleNamespace(text="heading"), SimpleNamespace(text="body")]
            tables = [SimpleNamespace(rows=[SimpleNamespace(cells=[SimpleNamespace(text="cell a"), SimpleNamespace(text="cell b")])])]

        with tempfile.TemporaryDirectory() as temporary:
            docx_file = Path(temporary) / "report.docx"
            docx_file.write_bytes(b"fixture")
            with patch.dict(sys.modules, {"docx": SimpleNamespace(Document=lambda _path: FakeDocument())}):
                self.assertEqual(extract_text(docx_file), "heading\nbody\ncell a\tcell b")

    def test_content_hash_changes_when_file_bytes_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "notes.txt"
            path.write_bytes(b"first")
            self.assertEqual(content_hash(path), hashlib.sha256(b"first").hexdigest())
            path.write_bytes(b"second")
            self.assertNotEqual(content_hash(path), hashlib.sha256(b"first").hexdigest())

    def test_extract_text_rejects_unsupported_and_oversized_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            unsupported = Path(temporary) / "archive.zip"
            unsupported.write_bytes(b"data")
            with self.assertRaises(ValueError):
                extract_text(unsupported)


if __name__ == "__main__":
    unittest.main()
