# Semantic File Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Each task follows TDD and ends with its focused checks.

**Goal:** Deliver a local semantic search path that indexes explicitly selected Windows folders, retrieves relevant supported files with EmbeddingGemma 2 and ChromaDB, and opens only a recent search result ID.

**Architecture:** A Python 3.12 JSONL worker owns extraction, chunking, embeddings, ChromaDB persistence, and the recent result-ID to canonical-path map. The Node bridge supervises the worker and exposes loopback endpoints; the React UI lets the user register a folder, index it, search, and open a result by ID. Pi tools call the same bridge endpoints and never receive arbitrary file paths.

**Tech Stack:** Python 3.12, `pypdf`, `python-docx`, Sentence Transformers with `google/embeddinggemma-2`, ChromaDB `PersistentClient`, Node.js/TypeScript bridge, React/Vite.

**Spec:** `VoicePilot_Docs/02-technical-requirements.md` section 5.5 and `VoicePilot_Docs/05-backend-schema.md` sections 7.8–7.9 and 9.4–9.5.

## Global Constraints

- Index only roots explicitly added by the user; never recursively index a default disk root.
- Support extractable-text PDF, DOCX, TXT, Markdown, and source-code text files.
- Store embeddings in ChromaDB and root/index metadata in local service state; do not persist embedding arrays in task history.
- Use distinct EmbeddingGemma 2 query and document prompts. Format titled documents as `title: {title} | text: {content}`.
- Return opaque result IDs, bounded snippets, relative paths, and metadata to the UI; keep canonical paths inside the local worker/bridge.
- Open only a result ID produced by a recent search, after rechecking root containment and file existence.
- Treat indexed document text as untrusted content, never as agent instructions.
- Keep model and vector data under ignored local application data; never put user files or model weights in the project distribution.

## Review Focus

- A symlink or junction points outside an approved root: canonicalize and reject it before indexing and before opening.
- A file changes or disappears after indexing: refresh by content hash and reject stale result IDs.
- A corrupt, encrypted, unsupported, or oversized document: record a per-file indexing error and continue the remaining batch.
- Re-indexing a root: upsert current chunks and remove stale chunks without clearing other roots.
- EmbeddingGemma or Chroma initialization fails: report file search unavailable and do not return an empty success result.

---

### Task 1: File Search Domain and Extraction

**Files:**
- Create: `services/file_search/__init__.py`
- Create: `services/file_search/core.py`
- Create: `services/file_search/test_core.py`
- Modify: `package.json` only if a focused Python test script is needed.

**Interfaces:**
- `canonicalize_root(path: str) -> Path` validates an existing directory and returns its resolved canonical path.
- `is_within_root(path: Path, root: Path) -> bool` compares resolved paths using Windows case-insensitive semantics.
- `extract_text(path: Path) -> str` extracts supported plain text, PDF text, or DOCX paragraphs.
- `chunk_text(text: str, *, max_chars: int = 1200, overlap: int = 160) -> list[str]` returns bounded, overlapping non-empty chunks.
- `content_hash(path: Path) -> str` hashes file bytes in bounded reads.

- [ ] **Step 1: Write failing tests** for supported formats, empty/corrupt documents, bounded overlap, hash changes, non-existent roots, and paths escaping roots.
- [ ] **Step 2: Run `python -m unittest services.file_search.test_core`** and confirm failures are caused by missing behavior.
- [ ] **Step 3: Implement the domain helpers** with no model or Chroma import in this module.
- [ ] **Step 4: Run the focused tests** and ensure every edge-case assertion passes.

### Task 2: Persistent Index, Embeddings, and Result IDs

**Files:**
- Create: `services/file_search/index.py`
- Create: `services/file_search/test_index.py`
- Create: `services/file_search/requirements.lock.txt`
- Create: `scripts/install-file-search.ps1`
- Modify: `.gitignore` only if the local vector/model paths need an additional ignore.

**Interfaces:**
- `FileSearchIndex(data_dir: Path, model_name: str = "google/embeddinggemma-2", *, embedder=None, vector_store=None)` supports fakes for unit tests and production implementations for runtime.
- `add_root(path: str) -> RootRecord` registers a canonical existing directory with a stable root ID.
- `index_root(root_id: str) -> IndexSummary` extracts and upserts content-hashed chunks and removes stale chunks belonging to that root.
- `search(query: str, limit: int = 5) -> list[SearchResult]` embeds queries with the `SearchQuery` prompt and returns stable, opaque result IDs with bounded snippets and relative paths.
- `resolve_result(result_id: str) -> Path` accepts only recent result IDs and revalidates root membership, file existence, and indexed content hash.
- `open_result(result_id: str) -> OpenResult` resolves the ID and invokes `os.startfile` on Windows; never accepts a path argument.

- [ ] **Step 1: Write failing fake-backed tests** for upsert, changed-file replacement, stale-chunk deletion, separate query/document prompts, per-root isolation, result-ID expiry, path containment, and missing/changed files.
- [ ] **Step 2: Run `python -m unittest services.file_search.test_index`** and confirm the missing index behavior fails.
- [ ] **Step 3: Implement ChromaDB persistence and the Sentence Transformers adapter.** Use explicit embeddings so Chroma does not silently choose a different embedding model. Encode documents with `prompt_name="Document"` and queries with `prompt_name="SearchQuery"`.
- [ ] **Step 4: Install pinned runtime dependencies in a dedicated Python 3.12 environment** under `.voicepilot-file-search`; keep model weights in the user cache and Chroma data under the VoicePilot local data directory.
- [ ] **Step 5: Run offline fake-backed tests** and, when model dependencies and network are available, a smoke test that loads EmbeddingGemma 2, indexes a local fixture, and retrieves it.

### Task 3: Worker Protocol and Bridge Lifecycle

**Files:**
- Create: `services/file_search/worker.py`
- Create: `services/file_search/test_worker.py`
- Create: `apps/bridge/src/file-search-client.ts`
- Create: `apps/bridge/src/file-search-client.test.ts`
- Modify: `apps/bridge/src/server.ts`
- Modify: `apps/bridge/src/server.test.ts` or the existing extracted HTTP harness.
- Modify: `scripts/install-windows.ps1`, root `package.json`, and `README.md` to expose optional setup.

**Interfaces:**
- Worker JSONL requests: `status`, `add_root {path}`, `index {rootId}`, `search {query, limit}`, and `open {resultId}`. One request returns one JSON response; errors are structured and do not terminate the worker.
- Bridge routes: `GET /api/file-search/status`, `GET|POST /api/file-search/roots`, `POST /api/file-search/index`, `POST /api/file-search/search`, and `POST /api/file-search/open`.
- The bridge validates payload sizes, search limit 1–10, query length, and worker state before dispatch.
- Worker stdout is reserved for JSONL; diagnostic logs go to stderr. Worker shutdown is awaited during bridge shutdown.

- [ ] **Step 1: Write failing tests** for worker JSONL protocol and Node client handling of malformed output, early exit, timeout, and cancellation.
- [ ] **Step 2: Implement and test the worker protocol** against a fake `FileSearchIndex`.
- [ ] **Step 3: Implement the TypeScript child-process client** with one serialized request at a time and deterministic cleanup.
- [ ] **Step 4: Add loopback API routes** and tests that reject invalid limits, arbitrary paths for open, missing result IDs, and unavailable worker state.
- [ ] **Step 5: Add optional Windows setup** and ensure the main installer does not download the model unless the user chooses file search.

### Task 4: Pi Tools and User Interface

**Files:**
- Create: `tools/pi/voicepilot-file-search.mjs`
- Create: `tools/pi/voicepilot-file-search.test.mjs`
- Modify: `apps/bridge/src/pi-installation.ts`, `apps/bridge/src/pi-rpc.ts`, and their tests.
- Modify: `apps/ui/src/App.tsx`, `apps/ui/src/styles.css`, and UI test setup if already available.
- Modify: `VoicePilot_Docs/05-backend-schema.md`, `IMPLEMENTATION_STATUS.md`, and `README.md`.

**Interfaces:**
- Pi `voicepilot_search_files({query, limit})` calls the bridge and returns only result IDs, filenames, relative paths, snippets, and modified time.
- Pi `voicepilot_open_file({resultId})` asks the bridge to open the path mapped to that result ID.
- The UI provides an explicit folder path field, indexed-root list, per-root indexing status, query/results, and an open button backed only by `resultId`.

- [ ] **Step 1: Write failing Pi-tool tests** for parameter bounds, authentication, result-ID-only open, and bridge errors.
- [ ] **Step 2: Implement Pi tools and load them through the pinned project Pi runtime.** Keep built-in filesystem tools disabled.
- [ ] **Step 3: Add a minimal accessible UI** for registering one folder, indexing it, searching, and opening result IDs.
- [ ] **Step 4: Run UI/bridge builds and the full test suite.** Verify no canonical absolute path is returned to the UI.
- [ ] **Step 5: Run an acceptance fixture** containing TXT, Markdown, source, DOCX, and text-based PDF files; verify search relevance, changed-file refresh, stale-ID rejection, and root containment.

## Acceptance Gate

- File-search status reports unavailable until both the Python runtime and index worker are ready.
- A user-selected folder can be indexed without touching files outside that folder.
- An EmbeddingGemma 2 semantic query returns the expected fixture document and a recent result ID.
- Opening an arbitrary path, a stale ID, or a result whose file moved outside its original approved root is rejected.
- Removing or re-indexing one root does not delete another root's vectors.
- The worker, bridge, and UI stop cleanly; full `npm test` and `npm run build` pass.

## External Technical References

- EmbeddingGemma 2 model card: https://huggingface.co/google/embeddinggemma-2
- Chroma Python client reference: https://docs.trychroma.com/reference/python
- Chroma local persistent client guide: https://docs.trychroma.com/docs/run-chroma/cloud-client
