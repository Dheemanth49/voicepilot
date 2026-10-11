# VoicePilot — Technical Requirements Document

**Version:** 1.0  
**Status:** Draft for implementation  
**Target:** Windows 11 desktop, local-first hackathon MVP  
**Related document:** [Product Requirements Document](01-prd.md)

## 1. Purpose

This document defines the technical architecture, service responsibilities, integration contracts, runtime requirements, security boundaries, and acceptance criteria for VoicePilot. It is intended to help four contributors implement modules in parallel without making incompatible assumptions.

## 2. Architecture principles

1. **Pi is the agent harness.** The bridge first asks Laya's local typed-choice model to choose chat, browser, desktop, or file search; Pi then owns task execution and tool selection for that route.
2. **Use Pi RPC first.** Run Pi as a supervised subprocess and communicate through its supported RPC protocol and TypeScript client. Do not write a custom JSONL implementation unless the official client cannot meet a proven need.
3. **Specialized models have bounded jobs.** STT transcribes speech; Laya chooses the top-level route and makes browser decisions; a configured local LLM answers chat and handles language reasoning, with KiloCode as its availability fallback; EmbeddingGemma 2 creates text embeddings; Piper speaks responses.
4. **Windows actions are tools, not generated code.** The LLM selects from predefined action schemas. It must not receive unrestricted shell, PowerShell, or Python execution.
5. **Verification is separate from planning.** A model request is not evidence that an action succeeded.
6. **UI and controlled browser are separate.** The web UI must not be the browser tab that Laya manipulates.
7. **Local-first.** Prefer local processing for desktop actions, file indexing, and LLM inference. Select KiloCode only if the configured local model or endpoint is unavailable.
8. **Verify behavior on the target laptop.** faster-whisper Large-v3 is the selected MVP STT model; local-model selection and KiloCode fallback must be accepted on Windows.

## 3. Logical components

| Component | Proposed implementation | Responsibility | Runs on |
|---|---|---|---|
| Web UI | React + Vite + TypeScript | Input, transcript, pending approval, results, history, settings | Local browser |
| Local bridge | Node.js + TypeScript | HTTP/WebSocket API, Pi lifecycle, task orchestration, event delivery | Windows host |
| Pi agent | Pi CLI in RPC mode | Conversational state, planning, tool selection, tool-result reasoning | Child process on Windows host |
| STT adapter | Python service or worker | Recording/audio normalization and transcription adapter | Windows host |
| Global hotkey/audio helper | Small native/Python helper | Global Alt+M toggle and audio capture coordination | Windows host |
| Laya decision layer | Laya `Decider` API via the persistent Python worker | Choose one offered route: chat, browser, desktop, or file search | Windows host |
| Browser automation | Laya Browser MCP | Dedicated browser tasks: navigation, search, clicks, forms, page inspection | Windows host/browser runtime |
| Desktop automation | `@amaster.ai/pi-computer-use` and supported CUA runtime | Native windows, mouse, keyboard, app interaction | Windows host |
| File-search service | Python + Sentence Transformers/Transformers + ChromaDB | Extract, chunk, embed, index, and retrieve approved files | Windows host |
| TTS adapter | Piper executable/library wrapper | Speak concise assistant responses | Windows host |
| Windows action utilities | Narrow custom tools, e.g. Pycaw/native Core Audio | Volume, graceful close, allowlisted app launch | Windows host |

The initial implementation may combine the STT adapter, hotkey helper, and TTS adapter into one Python service. Preserve logical interfaces even if processes are combined to save time.

## 4. Runtime and deployment

### 4.1 Supported runtime

- Windows 11, standard user account.
- Node.js LTS and npm.
- Python 3.x compatible with chosen model packages; pin and record the tested version.
- Pi CLI installed and able to run non-interactively in RPC mode.
- Chrome or another explicitly supported browser installed for controlled browsing.
- Microphone permission enabled.
- Network connection required for first-time package/model download and any selected cloud providers. Do not promise fully offline mode unless all model paths are confirmed local.

### 4.2 Local service binding

- Bind the bridge to `127.0.0.1` only by default.
- Never expose the bridge to the LAN without a deliberate authenticated design.
- Use an unpredictable per-run local token for browser-to-bridge requests where practical; reject requests from untrusted origins.
- Suggested development ports (change through configuration if occupied):
  - Web UI: Vite development port, e.g. `5173`.
  - Bridge HTTP/WebSocket: `8765`.
  - STT/audio service if separate: `8766`.
  - File search if separate: `8767`.
- Ports are implementation defaults, not a public API guarantee.

### 4.3 Process lifecycle

The bridge must:
- Start Pi using the supported RPC mode/client.
- Detect a failed startup or unexpected exit and surface an actionable UI error.
- Avoid starting multiple Pi sessions unintentionally.
- Stop child processes and audio capture cleanly on app shutdown.
- Keep model initialization out of latency-sensitive UI event handlers.
- Provide a manual transcript input in developer mode for testing when the microphone or STT provider is unavailable.

## 5. Model/service requirements

### 5.1 STT

MVP model: faster-whisper Large-v3, selected by the project owner. No model comparison or benchmark is planned.

Requirements:
- Define one provider-neutral interface: `transcribe(audio) -> transcript + metadata`.
- Normalize input sample rate, channel count, amplitude, and file/container format as required by the selected model.
- Return transcript, detected language if available, duration, latency, and error category.
- Support command audio approximately 1–10 seconds for the MVP.
- Do not execute a command if the transcript is empty or too uncertain to map safely; ask for repetition/clarification.
- Verify an actual recording transcribes on the target Windows laptop and that a spoken command reaches the same task pipeline as typed input.
- Runtime language, active model/device, and latency metadata are observability; they are not a comparative benchmark or acceptance score.

### 5.2 Main LLM and Pi

- Primary provider: configured local OpenAI-compatible inference endpoint registered in Pi's `models.json` (Ollama by default).
- Fallback provider: KiloCode when the configured local provider/model is missing, the local `/models` endpoint does not list the configured model, or local generation fails before any tool action starts. Never replay a request after a tool action has started, and do not silently select another provider.
- Report the active provider/model and fallback reason in bridge health and the UI. If neither provider has an available model, surface Pi as unavailable.
- Tool calls must map to registered functions with typed parameters.
- The model may create an ordered plan but must not define new executable tools at runtime.
- Constrain the active task to one execution queue for the MVP.
- Add timeouts and maximum step count (recommended MVP default: 5 planned actions per user request).
- If a plan contains an unsupported action, reject that step and explain; never substitute arbitrary code execution.

### 5.3 Laya Browser MCP

- Use Laya only for browser interaction and tasks within its supported tool contract.
- Launch a dedicated controlled browser profile/context; do not share the VoicePilot UI tab.
- Keep browser interaction in a separate tool group from native PC control.
- Expose Laya tools to Pi through an explicitly tested MCP adapter or custom Pi extension. Do not assume the tools are available to Pi automatically.
- Validate URLs and block unsafe schemes such as `javascript:` and arbitrary local file URLs unless a narrow, reviewed use case requires them.
- Browser page content is untrusted input and must not be allowed to override system policy.
- Compare Laya-assisted execution with a deterministic browser path for common actions; prefer the simpler reliable path when it suffices.

### 5.4 Windows computer use

- Use the selected Pi computer-use extension and its documented CUA runtime on Windows 11.
- Verify installation, permissions, window listing, app opening, scrolling, clicking, typing, and normal close behavior on the real demo computer.
- Do not treat force-kill as a normal close. Prefer graceful window close and confirm when loss of unsaved work is plausible.
- Keep an explicit application allowlist and validated launch mappings.
- Use a dedicated custom volume tool that sets a numeric 0–100 master-volume percentage and reads the resulting value back.

### 5.5 Semantic file search

- Model: `google/embeddinggemma-2`.
- Vector index: local ChromaDB.
- Start with explicitly user-selected folders; never recursively index the whole disk by default.
- Initial formats: PDF with extractable text, DOCX, TXT, Markdown, and source-code text.
- Extract metadata: absolute normalized path, file name, extension, modified time, chunk index, content hash, and text snippet/chunk.
- Follow the model card's exact task prompts/formatting for query and document embeddings. Keep query and document embedding methods separate.
- Re-index changed files and remove stale index entries.
- Open files only via a result identifier returned by the search service; resolve the identifier server-side to an indexed path under an approved root.
- Treat document content as untrusted text, not instructions for the agent.

### 5.6 Piper TTS

- Use Piper for short status/confirmation responses; text status is always available if TTS fails.
- Do not block the UI or main bridge event loop while audio is generated/played.
- Provide stop/mute controls and avoid speaking sensitive file excerpts by default.
- Review the Piper implementation license and selected voice model terms before packaging/distribution.

## 6. Core functional requirements

| ID | Requirement | Priority | Acceptance evidence |
|---|---|---|---|
| TR-01 | Global Alt+M starts and stops recording | P0 | Works while another app is foregrounded |
| TR-02 | User can submit a typed transcript in developer mode | P0 | Runs through the same plan/execute pipeline |
| TR-03 | STT adapter transcribes supported audio | P0 | Real audio transcribes and its command reaches the task pipeline on the target laptop |
| TR-04 | Pi RPC bridge processes prompts and streams status | P0 | UI shows an in-progress event and final result |
| TR-05 | Open allowlisted app | P0 | Application/window appears and result verifies it |
| TR-06 | Close app safely | P0 | Normal close first; confirmation when appropriate |
| TR-07 | Scroll with bounded distance | P0 | Foreground target changes position |
| TR-08 | Set volume/mute | P0 | Read-back matches expected state within defined tolerance |
| TR-09 | Search web/navigate browser | P0 | Search page opens; back/forward works |
| TR-10 | User can approve/deny pending action | P0 | Denial guarantees action is not dispatched |
| TR-11 | File semantic search in approved folder | P1 | Relevant results with filenames and snippets |
| TR-12 | Open selected file result | P1 | Result ID validated against approved root |
| TR-13 | Multi-step ordered plan | P1 | Each step has independent status and stop-on-failure policy |
| TR-14 | Piper response | P1 | Non-blocking TTS with text fallback |
| TR-15 | Contextual follow-up | P1 | “Scroll more” uses current controlled target if available |
| TR-16 | Action history | P0 | Transcript, action, status, timestamp recorded without raw audio by default |

## 7. Cross-component contracts

### 7.1 Action plan contract

All agent-selected actions must resolve to an approved action name and validated parameters. Example:

```json
{
  "task_id": "task_01HXYZ",
  "steps": [
    { "action": "open_app", "args": { "app_id": "chrome" } },
    { "action": "search_web", "args": { "query": "TinyViT federated learning" } }
  ]
}
```

- Ignore any model-supplied executable string or shell command.
- The bridge validates the action name, arguments, and user permissions before dispatch.
- A plan with unknown fields or unsupported actions must be rejected or sanitized according to an explicit schema; do not silently reinterpret it.

### 7.2 Execution result contract

Every action returns a result with:
- `action_id`, `task_id`, `status` (`succeeded`, `failed`, `blocked`, `cancelled`, `needs_confirmation`).
- `started_at`, `finished_at`, duration.
- A human-readable summary.
- A typed error code for failures.
- Optional structured evidence, such as resolved app/window title, verified volume, or returned file result IDs.

### 7.3 Confirmation contract

For an action requiring approval:
1. Bridge creates a one-use `approval_id` and emits a pending-approval event.
2. The action stays unexecuted while pending.
3. UI submits approve/deny using that ID.
4. Bridge validates that the approval is still pending and not expired, then dispatches only on approval.
5. A denial, timeout, cancellation, or stale ID must not execute the action.

## 8. Security and privacy requirements

- No API keys in React client bundles. Read secrets only from protected local configuration/environment.
- `.env` and credentials files must be gitignored; commit only `.env.example` with variable names.
- Bind local services to loopback and validate Origin/Host and request payloads.
- Use allowlists for application identifiers and approved file roots.
- Prevent path traversal, unapproved absolute paths, arbitrary URL schemes, and arbitrary shell commands.
- Keep the file-search database local. Do not send retrieved file chunks to a cloud LLM unless cloud processing is enabled and the user has been informed.
- Avoid storing raw voice recordings. Store transcript and operation metadata only where needed; allow clearing history and the index.
- Browser/document content can contain prompt-injection attempts. Treat it as quoted/untrusted data and enforce action policies in code.
- Confirm destructive or disruptive actions. The MVP should not delete files, change security settings, or run administrator-level tasks.

## 9. Proposed quality targets

These are initial engineering targets, not measured promises. Record actual results on the chosen laptop and revise if hardware constraints make a target unrealistic.

- UI feedback for start/stop recording: under 150 ms after local event.
- Bridge-to-UI status event delivery: under 100 ms on the local machine under normal load.
- Common voice command (recording stopped to first visible result): target under 5 seconds for simple commands, excluding long STT/LLM cold starts.
- Simple desktop action completion: target under 3 seconds after validated tool dispatch where the OS/application permits.
- Semantic search over an initial index of up to 5,000 extracted chunks: target under 1 second for vector retrieval after embeddings/model are loaded; file extraction/indexing is measured separately.
- Full demo: succeed twice consecutively without restarting the application.
- No false-success state: 100% of tested failure simulations must display failure/blocked/cancelled rather than success.

## 10. Test requirements

### Unit tests
- Parameter validation for all tools.
- Application allowlist and path validation.
- Volume bounds and read-back handling.
- Action/approval state transitions.
- Transcript normalization and empty transcript handling.
- Search result ID mapping and approved-root validation.

### Integration tests
- React → bridge → Pi RPC → mock tool → UI result.
- Actual Pi → computer-use extension → Notepad open/inspect.
- Pi → Laya adapter → browser search/navigation.
- Voice recording → STT → Pi → tool result.
- File extraction → EmbeddingGemma 2 → ChromaDB → result ID → open-file tool.
- Confirmation denied and confirmation expired produce no action execution.

### End-to-end tests
- “Open Notepad.”
- “Set volume to 30 percent.”
- “Search for TinyViT federated learning, then scroll down.”
- “Find my notes about federated learning” followed by “Open the first result.”
- Ambiguous request elicits clarification.
- Unsupported request is safely rejected.
- STT or LLM service unavailable produces a usable error state.

## 11. Definition of technical readiness

The architecture is ready for the hackathon demo when:
- The chosen Windows runtime works on the demo laptop.
- The bridge can start and communicate with Pi via RPC.
- At least one browser tool and one desktop tool can be invoked from Pi.
- STT can supply a transcript into that same action pipeline.
- Confirmation gates are enforced by the bridge, not only by prompt wording.
- All P0 acceptance checks pass on the target laptop.
- The team has a documented fallback if a local model, GPU backend, or remote provider fails.

## 12. References

- Pi RPC: https://pi.dev/docs/latest/rpc
- Pi extensions: https://pi.dev/docs/latest/extensions
- Pi computer-use: https://pi.dev/packages/@amaster.ai/pi-computer-use
- Laya Browser MCP: https://github.com/bala2006/laya-browser-mcp
- faster-whisper: https://github.com/SYSTRAN/faster-whisper
- Gemma 4 E2B: https://huggingface.co/google/gemma-4-E2B
- EmbeddingGemma 2: https://huggingface.co/google/embeddinggemma-2
- ChromaDB: https://docs.trychroma.com/
- Piper: https://github.com/OHF-Voice/piper1-gpl
