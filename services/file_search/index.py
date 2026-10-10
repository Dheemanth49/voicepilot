from __future__ import annotations

import hashlib
import gc
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Callable, Protocol

from .core import TEXT_EXTENSIONS, canonicalize_root, chunk_text, content_hash, extract_text, is_within_root


MODEL_ID = "google/embeddinggemma-2"
RESULT_TTL_SECONDS = 30 * 60
MAX_INDEXED_FILES_PER_ROOT = 50_000


class Embedder(Protocol):
    def encode(self, texts: list[str], *, prompt_name: str | None): ...


class Collection(Protocol):
    def upsert(self, *, ids: list[str], embeddings: list[list[float]], documents: list[str], metadatas: list[dict]): ...
    def delete(self, *, where: dict | None = None, ids: list[str] | None = None): ...
    def query(self, *, query_embeddings: list[list[float]], n_results: int, include: list[str], where: dict | None = None): ...
    def count(self) -> int: ...


class FileSearchIndex:
    """Persistent approved-root index and server-side result-ID resolver."""

    def __init__(self, database_path: Path, collection: Collection, embedder: Embedder,
                 *, open_file: Callable[[Path], object] | None = None):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.collection = collection
        self.embedder = embedder
        self._open_file = open_file or self._open_with_windows
        self.database = sqlite3.connect(self.database_path, timeout=10)
        self.database.row_factory = sqlite3.Row
        self._create_tables()

    def close(self):
        self.database.close()

    def _create_tables(self):
        self.database.executescript("""
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS approved_roots (
                root_id TEXT PRIMARY KEY,
                canonical_path TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS file_index_metadata (
                file_key TEXT PRIMARY KEY,
                root_id TEXT NOT NULL REFERENCES approved_roots(root_id) ON DELETE CASCADE,
                canonical_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                extension TEXT,
                modified_at TEXT,
                content_hash TEXT NOT NULL,
                indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                index_status TEXT NOT NULL,
                chunk_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS file_index_root ON file_index_metadata(root_id);
            CREATE TABLE IF NOT EXISTS search_results (
                result_id TEXT PRIMARY KEY,
                root_id TEXT NOT NULL REFERENCES approved_roots(root_id) ON DELETE CASCADE,
                file_key TEXT NOT NULL REFERENCES file_index_metadata(file_key) ON DELETE CASCADE,
                canonical_path TEXT NOT NULL,
                expires_at REAL NOT NULL
            );
        """)
        self.database.commit()

    def add_root(self, path: str) -> str:
        root = canonicalize_root(path)
        existing = self.database.execute(
            "SELECT root_id FROM approved_roots WHERE canonical_path=?", (str(root),)
        ).fetchone()
        if existing:
            self.database.execute("UPDATE approved_roots SET enabled=1 WHERE root_id=?", (existing["root_id"],))
            self.database.commit()
            return existing["root_id"]
        root_id = "root_" + uuid.uuid4().hex
        self.database.execute(
            "INSERT INTO approved_roots(root_id, canonical_path, display_name, enabled) VALUES (?, ?, ?, 1)",
            (root_id, str(root), root.name or str(root)),
        )
        self.database.commit()
        return root_id

    def list_roots(self) -> list[dict]:
        return [dict(row) for row in self.database.execute(
            """SELECT r.root_id, r.canonical_path, r.display_name, r.enabled, r.added_at,
                      COUNT(CASE WHEN f.index_status='ready' THEN 1 END) AS indexed_file_count,
                      COALESCE(SUM(CASE WHEN f.index_status='ready' THEN f.chunk_count ELSE 0 END), 0) AS indexed_chunk_count
               FROM approved_roots r LEFT JOIN file_index_metadata f ON f.root_id=r.root_id
               GROUP BY r.root_id ORDER BY r.added_at, r.display_name"""
        )]

    def remove_root(self, root_id: str):
        root = self.database.execute("SELECT root_id FROM approved_roots WHERE root_id=?", (root_id,)).fetchone()
        if not root:
            raise ValueError("The approved folder was not found.")
        self.collection.delete(where={"root_id": root_id})
        self.database.execute("DELETE FROM approved_roots WHERE root_id=?", (root_id,))
        self.database.commit()

    def index_root(self, root_id: str) -> dict:
        root = self._get_enabled_root(root_id)
        root_path = canonicalize_root(root["canonical_path"])
        seen: set[str] = set()
        indexed = unchanged = failed = removed = 0

        for path in self._walk_files(root_path):
            if len(seen) >= MAX_INDEXED_FILES_PER_ROOT:
                raise ValueError(f"Folder exceeds the {MAX_INDEXED_FILES_PER_ROOT} file indexing limit.")
            try:
                canonical = path.resolve(strict=True)
                if not is_within_root(canonical, root_path):
                    continue
                key = self._file_key(root_id, canonical)
                seen.add(key)
                digest = content_hash(canonical)
                current = self.database.execute(
                    "SELECT content_hash, index_status, chunk_count FROM file_index_metadata WHERE file_key=?", (key,)
                ).fetchone()
                if current and current["content_hash"] == digest and current["index_status"] == "ready":
                    unchanged += 1
                    continue
                try:
                    text = extract_text(canonical)
                    if content_hash(canonical) != digest:
                        raise ValueError("File changed while it was being indexed. Run indexing again.")
                    chunks = chunk_text(text)
                    old_chunk_count = current["chunk_count"] if current else 0
                    if chunks:
                        title = canonical.name.replace("\n", " ").replace("\r", " ")
                        documents = [f"title: {title} | text: {chunk}" for chunk in chunks]
                        embeddings = self._encode(documents, None)
                        modified = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(canonical.stat().st_mtime))
                        ids = [f"{key}:{index}" for index in range(len(chunks))]
                        metadata = [{
                            "file_key": key,
                            "chunk_index": index,
                            "root_id": root_id,
                            "canonical_path": str(canonical),
                            "file_name": canonical.name,
                            "extension": canonical.suffix.lower(),
                            "modified_at": modified,
                            "content_hash": digest,
                        } for index in range(len(chunks))]
                        for start in range(0, len(chunks), 256):
                            end = start + 256
                            self.collection.upsert(
                                ids=ids[start:end], embeddings=embeddings[start:end],
                                documents=chunks[start:end], metadatas=metadata[start:end],
                            )
                        # Keep the previous index searchable until replacement embeddings
                        # have been generated and written successfully. Chunk IDs are stable,
                        # so only obsolete trailing chunks need removal after upsert.
                        if old_chunk_count > len(chunks):
                            self.collection.delete(ids=[f"{key}:{index}" for index in range(len(chunks), old_chunk_count)])
                    else:
                        self.collection.delete(where={"file_key": key})
                        modified = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(canonical.stat().st_mtime))
                    self.database.execute("""
                        INSERT INTO file_index_metadata(file_key, root_id, canonical_path, file_name, extension,
                            modified_at, content_hash, index_status, chunk_count)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)
                        ON CONFLICT(file_key) DO UPDATE SET root_id=excluded.root_id,
                            canonical_path=excluded.canonical_path, file_name=excluded.file_name,
                            extension=excluded.extension, modified_at=excluded.modified_at,
                            content_hash=excluded.content_hash, indexed_at=CURRENT_TIMESTAMP,
                            index_status='ready', chunk_count=excluded.chunk_count
                    """, (key, root_id, str(canonical), canonical.name, canonical.suffix.lower(), modified, digest, len(chunks)))
                    indexed += 1
                except Exception:
                    # Preserve the previous good index; the hash mismatch causes a retry
                    # on the next indexing pass. A new file has no stale vector to retain.
                    failed += 1
            except (OSError, RuntimeError, ValueError):
                failed += 1

        old_rows = self.database.execute(
            "SELECT file_key FROM file_index_metadata WHERE root_id=?", (root_id,)
        ).fetchall()
        stale_ids = [row["file_key"] for row in old_rows if row["file_key"] not in seen]
        for key in stale_ids:
            self.collection.delete(where={"file_key": key})
            self.database.execute("DELETE FROM file_index_metadata WHERE file_key=?", (key,))
        removed = len(stale_ids)
        self.database.commit()
        return {"rootId": root_id, "indexed": indexed, "unchanged": unchanged, "failed": failed, "removed": removed}

    def search(self, query: str, limit: int = 5) -> list[dict]:
        if not isinstance(query, str) or not query.strip() or len(query) > 1000:
            raise ValueError("A search query from 1 to 1000 characters is required.")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 10:
            raise ValueError("Search result limit must be from 1 to 10.")
        roots = [row["root_id"] for row in self.database.execute("SELECT root_id FROM approved_roots WHERE enabled=1")]
        if not roots:
            raise ValueError("Choose an approved folder and index it before searching.")
        placeholders = ",".join("?" for _ in roots)
        indexed_chunks = self.database.execute(
            f"SELECT COALESCE(SUM(chunk_count), 0) FROM file_index_metadata WHERE index_status='ready' AND root_id IN ({placeholders})",
            roots,
        ).fetchone()[0]
        if indexed_chunks == 0:
            raise ValueError("No searchable content is indexed yet. Click Index next to an approved folder, then search again.")
        vector = self._encode([query.strip()], "SearchQuery")[0]
        indexed_count = self.collection.count()
        if indexed_count == 0:
            raise RuntimeError("The vector index is empty. Re-index an approved folder from Settings, then search again.")
        response = self.collection.query(
            query_embeddings=[vector], n_results=min(max(limit * 5, 10), indexed_count),
            include=["documents", "metadatas", "distances"],
            where={"root_id": {"$in": roots}} if len(roots) > 1 else {"root_id": roots[0]},
        )
        ids = response.get("ids", [[]])[0]
        documents = response.get("documents", [[]])[0]
        metadatas = response.get("metadatas", [[]])[0]
        distances = response.get("distances", [[]])[0]
        best: dict[str, tuple[float, dict, str]] = {}
        for vector_id, document, metadata, distance in zip(ids, documents, metadatas, distances):
            root_id = metadata.get("root_id")
            file_key = metadata.get("file_key")
            if root_id not in roots or not isinstance(file_key, str):
                continue
            row = self.database.execute(
                "SELECT canonical_path, file_name, extension, modified_at FROM file_index_metadata "
                "WHERE file_key=? AND root_id=? AND index_status='ready'", (file_key, root_id)
            ).fetchone()
            if not row:
                continue
            score = max(0.0, min(1.0, 1.0 - float(distance)))
            previous = best.get(file_key)
            if not previous or score > previous[0]:
                best[file_key] = (score, dict(row), document or "")

        self.database.execute("DELETE FROM search_results WHERE expires_at < ?", (time.time(),))
        results = []
        for file_key, (score, row, document) in sorted(best.items(), key=lambda item: item[1][0], reverse=True)[:limit]:
            root_row = self.database.execute("SELECT canonical_path FROM approved_roots WHERE enabled=1 AND root_id=(SELECT root_id FROM file_index_metadata WHERE file_key=?)", (file_key,)).fetchone()
            if not root_row:
                continue
            file_path = Path(row["canonical_path"])
            root_path = Path(root_row["canonical_path"])
            if not is_within_root(file_path, root_path):
                continue
            result_id = "result_" + uuid.uuid4().hex[:20].upper()
            root_id = self.database.execute("SELECT root_id FROM file_index_metadata WHERE file_key=?", (file_key,)).fetchone()[0]
            self.database.execute(
                "INSERT INTO search_results(result_id, root_id, file_key, canonical_path, expires_at) VALUES (?, ?, ?, ?, ?)",
                (result_id, root_id, file_key, str(file_path), time.time() + RESULT_TTL_SECONDS),
            )
            snippet = " ".join(document.split())[:360]
            results.append({
                "resultId": result_id,
                "fileName": row["file_name"],
                "extension": row["extension"],
                "rootRelativePath": str(file_path.relative_to(root_path)),
                "snippet": snippet,
                "modifiedAt": row["modified_at"],
                "score": round(score, 4),
            })
        self.database.commit()
        return results

    def open_result(self, result_id: str) -> dict:
        if not isinstance(result_id, str) or not result_id.startswith("result_"):
            raise ValueError("Open a file using a recent search result ID.")
        record = self.database.execute("""
            SELECT sr.canonical_path, sr.file_key, r.canonical_path AS root_path, r.root_id
            FROM search_results sr
            JOIN approved_roots r ON r.root_id=sr.root_id AND r.enabled=1
            JOIN file_index_metadata f ON f.file_key=sr.file_key AND f.root_id=sr.root_id AND f.index_status='ready'
            WHERE sr.result_id=? AND sr.expires_at>=?
        """, (result_id, time.time())).fetchone()
        if not record:
            raise ValueError("That search result has expired or its folder is no longer approved.")
        try:
            root = canonicalize_root(record["root_path"])
            path = Path(record["canonical_path"]).resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as error:
            raise ValueError("The file no longer exists or cannot be resolved.") from error
        if not path.is_file() or not is_within_root(path, root):
            raise ValueError("The file is no longer inside its approved folder.")
        metadata = self.database.execute("SELECT content_hash FROM file_index_metadata WHERE file_key=?", (record["file_key"],)).fetchone()
        if not metadata or content_hash(path) != metadata["content_hash"]:
            raise ValueError("The file changed after the search. Re-index the folder and search again.")
        self._open_file(path)
        return {"opened": True}

    def _get_enabled_root(self, root_id: str):
        root = self.database.execute("SELECT * FROM approved_roots WHERE root_id=? AND enabled=1", (root_id,)).fetchone()
        if not root:
            raise ValueError("The approved folder was not found or is disabled.")
        return root

    @staticmethod
    def _file_key(root_id: str, canonical_path: Path) -> str:
        identity = f"{root_id}\0{os.path.normcase(str(canonical_path))}".encode("utf-8")
        return hashlib.sha256(identity).hexdigest()

    @staticmethod
    def _walk_files(root: Path):
        for current, directories, filenames in os.walk(root, followlinks=False):
            current_path = Path(current)
            directories[:] = [name for name in sorted(directories)
                              if not (current_path / name).is_symlink()
                              and not getattr(current_path / name, "is_junction", lambda: False)()]
            for name in sorted(filenames):
                path = current_path / name
                if path.suffix.lower() in TEXT_EXTENSIONS | {".pdf", ".docx"} and not path.is_symlink():
                    yield path

    def _encode(self, texts: list[str], prompt_name: str | None) -> list[list[float]]:
        vectors = self.embedder.encode(texts, prompt_name=prompt_name)
        if hasattr(vectors, "tolist"):
            vectors = vectors.tolist()
        if texts and vectors and not isinstance(vectors[0], (list, tuple)):
            vectors = [vectors]
        return [[float(value) for value in vector] for vector in vectors]

    @staticmethod
    def _open_with_windows(path: Path):
        if not hasattr(os, "startfile"):
            raise RuntimeError("Opening indexed files is supported only on Windows.")
        os.startfile(str(path))


class SentenceTransformerEmbedder:
    def __init__(self, model_id: str = MODEL_ID, device_preference: str | None = None):
        import torch
        from sentence_transformers import SentenceTransformer

        self.model_id = model_id
        self._torch = torch
        self._sentence_transformer = SentenceTransformer
        preference = device_preference if device_preference is not None else os.environ.get("VOICEPILOT_FILE_SEARCH_DEVICE", "auto")
        if preference not in {"auto", "cpu", "cuda"}:
            raise ValueError("File-search device must be auto, cpu, or cuda.")
        self.device_preference = preference
        self.fallback_reason: str | None = None
        cuda_available = bool(torch.cuda.is_available())

        if preference == "cuda" and not cuda_available:
            raise RuntimeError(
                "CUDA was requested for local file search, but PyTorch cannot access an NVIDIA CUDA device. "
                "Install a compatible NVIDIA driver, run npm run setup:file-search:gpu, "
                "then run npm run diagnose:gpu."
            )

        selected_device = "cpu"
        if preference == "cuda" or (preference == "auto" and cuda_available):
            selected_device = "cuda"
        elif preference == "auto":
            self.fallback_reason = "CUDA is not available to PyTorch; using CPU."

        try:
            self.model = self._load_model(SentenceTransformer, model_id, selected_device, torch)
            self.active_device = selected_device
        except Exception as cuda_error:
            if preference != "auto" or selected_device != "cuda":
                self._raise_model_error(cuda_error)
            self.fallback_reason = f"CUDA initialization failed ({type(cuda_error).__name__}: {cuda_error}); using CPU."
            del cuda_error
            gc.collect()
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
            try:
                self.model = self._load_model(SentenceTransformer, model_id, "cpu", torch)
                self.active_device = "cpu"
            except Exception as cpu_error:
                try:
                    self._raise_model_error(cpu_error)
                except RuntimeError as translated:
                    raise RuntimeError(f"CUDA fallback failed; {translated}") from cpu_error

    @staticmethod
    def _load_model(sentence_transformer, model_id: str, device: str, torch):
        return sentence_transformer(
            model_id,
            device=device,
            model_kwargs={"torch_dtype": torch.float32},
            config_kwargs={"vision_config": None, "audio_config": None},
        )

    @staticmethod
    def _raise_model_error(error: Exception):
        message = str(error).lower()
        if getattr(error, "winerror", None) == 1455 or "paging file is too small" in message:
            raise RuntimeError(
                "Windows ran out of committed memory while loading EmbeddingGemma 2. "
                "Close memory-heavy apps, enable the system-managed paging file, restart Windows, "
                "then restart VoicePilot."
            ) from error
        raise RuntimeError(f"Could not load EmbeddingGemma 2: {type(error).__name__}: {error}") from error

    def encode(self, texts: list[str], *, prompt_name: str | None):
        if prompt_name not in {None, "SearchQuery"}:
            raise ValueError("Unsupported EmbeddingGemma task prompt.")
        options = {"normalize_embeddings": True, "batch_size": 8}
        if prompt_name is not None:
            options["prompt_name"] = prompt_name
        try:
            return self.model.encode(texts, **options)
        except Exception as cuda_error:
            if self.device_preference != "auto" or self.active_device != "cuda":
                raise
            self.fallback_reason = f"CUDA embedding failed ({type(cuda_error).__name__}: {cuda_error}); using CPU."
            self.model = None
            gc.collect()
            try:
                self._torch.cuda.empty_cache()
            except Exception:
                pass
            try:
                self.model = self._load_model(self._sentence_transformer, self.model_id, "cpu", self._torch)
                self.active_device = "cpu"
                return self.model.encode(texts, **options)
            except Exception as cpu_error:
                try:
                    self._raise_model_error(cpu_error)
                except RuntimeError as translated:
                    raise RuntimeError(
                        f"CUDA embedding failed ({type(cuda_error).__name__}: {cuda_error}); "
                        f"CPU fallback failed: {translated}"
                    ) from cpu_error


def create_chroma_collection(persist_directory: Path):
    import chromadb

    client = chromadb.PersistentClient(path=str(persist_directory))
    return client.get_or_create_collection(
        name="voicepilot_files_v1",
        metadata={"hnsw:space": "cosine", "model_id": MODEL_ID},
    )
