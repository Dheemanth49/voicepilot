# VoicePilot
## Product Requirements Document (PRD)

**Document version:** 1.0  
**Status:** Draft for implementation  
**Product type:** Local-first, voice-controlled Windows desktop agent  
**Target platform:** Windows 11  
**Team:** 4 contributors  
**Delivery context:** Hackathon MVP, approximately 12–24 hours remaining  
**Working product name:** VoicePilot (renameable)

> **Product promise:** Speak naturally to control your Windows PC, find files by meaning, and see proof of what the agent actually did.

\newpage

## Document guide

1. Executive summary
2. Product vision and problem
3. Goals and non-goals
4. Target users and use cases
5. Hackathon judging alignment
6. Scope and release priorities
7. Technology decisions and open choices
8. System architecture
9. End-to-end interaction flows
10. Functional requirements
11. Tool contracts and action policy
12. Voice, STT, LLM, TTS, and retrieval requirements
13. UX and accessibility requirements
14. Security, privacy, and safety
15. Performance and quality targets
16. Testing and acceptance plan
17. Delivery plan and team responsibilities
18. Risks and mitigations
19. Suggested repository structure
20. Demo and pitch storyboard
21. Definition of done
22. References

## 1. Executive summary

VoicePilot is a voice-first desktop assistant for Windows 11. The user speaks a command; a speech-to-text (STT) component transcribes it; the Pi agent, using a configured language model, interprets the request and selects from a constrained tool set; computer-use or browser tools perform the action; and the UI reports the verified result. A local semantic-search service powered by Google EmbeddingGemma 2 adds the ability to find files and documents by topic rather than exact filename. Piper TTS can speak short responses aloud.

The project will reuse existing agent and automation infrastructure rather than implement a new agent framework. Pi is the orchestration layer. Pi RPC is the initial integration path between a local Node.js/TypeScript bridge and the running Pi process. Laya Browser MCP is the specialized browser automation path. The Pi computer-use extension and its supported Windows runtime are the native desktop-control path. The React web UI is served locally and communicates with the bridge.

The first objective is not to support every possible computer task. It is to create a reliable, attractive demonstration of a focused set of actions: open and close supported applications, scroll, set or mute system volume, search the web, navigate browser history, and search/open files. Multi-step commands, safe confirmations, contextual follow-ups, and verified execution are the primary differentiators.

**Critical implementation principle:** The LLM may select from approved tools; it must not be given unrestricted shell or PowerShell execution. The application validates every tool call, applies confirmation policies, executes it, verifies the outcome where possible, and records the result. The system must never claim success based only on a model response.

## 2. Product vision and problem

### 2.1 Problem statement

Many everyday desktop tasks require repeated mouse and keyboard interactions. Existing voice dictation can enter text but often does not reliably plan and execute cross-application actions. Basic voice-command systems are brittle when users speak naturally, combine multiple actions, refer to a previous result, or ask for a file by its meaning rather than its name.

VoicePilot aims to provide one simple interface for hands-free desktop control and lightweight task execution. It should reduce interaction friction without sacrificing user understanding, safety, or control.

### 2.2 Product vision

A user can say what they want done, not how to click through it. VoicePilot interprets the request, proposes or performs permitted actions, verifies results, and asks when an instruction is ambiguous or risky.

### 2.3 Product positioning

**VoicePilot is a local-first voice agent for desktop productivity and accessibility.** It combines voice interaction, agent-based planning, controlled browser and desktop tools, and semantic file search. The system is designed to be transparent: users can inspect the transcript, intended actions, execution status, and recent activity.

“Local-first” means that desktop control and the file index remain on the user's machine, and local model options are preferred where they meet the quality bar. The initial STT and LLM configuration is still subject to benchmark results. If a cloud provider is used, the UI must disclose that audio or prompt content is sent to that provider.

## 3. Goals and non-goals

### 3.1 Goals

- Provide a working Windows 11 voice-control MVP.
- Use **Alt+M** as the global start/stop recording toggle.
- Convert speech to text with a tested STT model.
- Use Pi as the agent harness, with Pi RPC connecting it to the local application bridge.
- Use a local Gemma 4 E2B instruction-tuned model as the first local LLM candidate, provided its runtime and tool-calling behavior pass the integration tests.
- Use Laya Browser MCP for appropriate browser tasks, with a separate computer-use path for native Windows interactions.
- Support a bounded set of native desktop actions and browser navigation/search.
- Search selected local folders semantically with `google/embeddinggemma-2` and a local vector index.
- Provide visible status, confirmation, errors, and action history.
- Verify actual action outcomes and handle failures honestly.
- Prepare a repeatable 2–3 minute live demonstration aligned to the hackathon rubric.

### 3.2 Non-goals for the hackathon MVP

- General-purpose autonomous operation of every Windows application.
- Unrestricted terminal, PowerShell, administrator, or arbitrary code execution.
- Automatically deleting files, shutting down the machine, changing security settings, or performing irreversible system operations.
- Full document question-answering, OCR of every scanned PDF, or indexing the entire computer by default.
- Multi-user accounts, cloud synchronization, remote control, a hosted SaaS backend, or billing.
- Training a new speech or language model.
- Guaranteed offline operation until STT, LLM, and TTS are verified locally.
- Building a separate multi-agent framework around Pi.

## 4. Target users and primary use cases

### 4.1 Primary audiences

1. **Hands-free productivity users:** people who want to reduce repetitive keyboard/mouse interaction while coding, researching, studying, or presenting.
2. **Accessibility users:** people who benefit from voice-driven access to common desktop actions. The hackathon prototype is not represented as a certified assistive technology product.
3. **Power users and students:** people who switch between documents, browsers, editors, and research material frequently.

### 4.2 MVP user stories

- As a user, I can press Alt+M, speak a command, and press Alt+M again to stop recording.
- As a user, I can say “Open Notepad” and see whether it opened successfully.
- As a user, I can say “Set my volume to 30 percent” and see the volume change.
- As a user, I can say “Search the web for TinyViT federated learning” and see a search page open in the controlled browser.
- As a user, I can say “Find my notes about federated learning” and receive semantically relevant files from folders I selected.
- As a user, I can say “Open the first result” and have the application open a previously returned, validated result.
- As a user, I can combine actions in one sentence and see the plan and individual outcomes.
- As a user, I can cancel or decline a confirmation and know that the pending action was not executed.
- As a user, I can tell whether a command failed, was blocked, or needs clarification.

## 5. Hackathon judging alignment

The known rubric is: Working MVP 30%, AI/SaaS relevance 20%, UI/UX 15%, market potential 15%, innovation 10%, demo and pitch 10%.

| Criterion | Product evidence | Demo evidence |
|---|---|---|
| Working MVP — 30% | All required desktop actions work; speech-to-action loop is integrated | Live voice command changes the real PC and reports result |
| AI/SaaS relevance — 20% | Pi planning, structured tool use, multi-step requests, semantic retrieval | One compound command plus a contextual follow-up |
| UI/UX — 15% | Listening state, transcript, plan, approvals, success/failure, history | Judges can understand each step without reading logs |
| Market potential — 15% | Hands-free productivity/accessibility use cases, focused target user | Explain who benefits and how the product might be deployed or licensed |
| Innovation — 10% | Context-aware commands, semantic local file search, verified execution | Find a document by meaning, open it, then perform another action |
| Demo and pitch — 10% | Stable build and documented fallback plan | Rehearsed 2–3 minute demonstration with no unsupported claims |

## 6. Scope and release priorities

### P0 — required for the MVP

- Global Alt+M recording toggle.
- STT from the selected candidate model.
- Pi agent request/response through Pi RPC.
- Open allowlisted applications.
- Close supported applications safely; confirmation is required where appropriate.
- Scroll up/down with bounded amounts.
- Set volume by percentage; mute/unmute.
- Web search and basic browser back/forward navigation.
- UI transcript, listening/processing/execution states, confirmation prompt, success/failure result.
- Action allowlist, parameter validation, and no arbitrary shell tool.

### P1 — differentiators to add if the full vertical slice is stable

- Multi-step action plans.
- Semantic search over a selected folder using EmbeddingGemma 2 and ChromaDB.
- Open a result by selecting a result ID, not an LLM-invented path.
- Contextual commands such as “scroll a bit more” and “open the first result.”
- Verified execution, safe retry suggestions, and activity history.
- Piper TTS for short status responses.

### P2 — stretch goals

- Reusable named workflows/macros.
- Pause/cancel between steps in long workflows.
- Multilingual and code-switching commands, after language evaluation.
- OCR for scanned PDFs or screenshots.
- Screen understanding for unfamiliar interfaces.
- Fully offline operation across every model component.

**Scope rule:** If time is tight, defer P2 and simplify file search before cutting P0 reliability or safety. A polished, successful end-to-end command is more valuable than an incomplete feature list.

## 7. Technology decisions and open choices

| Area | Current decision/candidate | Status and notes |
|---|---|---|
| OS | Windows 11 | Chosen target due to CUA runtime compatibility concerns encountered on Arch Linux |
| Frontend | React + Vite | Planned; UI is hosted locally in a browser |
| Local application bridge | Node.js + TypeScript | Planned; owns WebSocket/API, Pi process, events, and coordination |
| Agent integration | Pi RPC | Initial integration choice; use the maintained TypeScript RPC client where feasible |
| Agent model | Gemma 4 E2B instruction-tuned checkpoint | Candidate; verify exact model ID, runtime support, context, and real tool-calling quality |
| STT | faster-whisper Large-v3 vs ARK-ASR-0.6B | faster-whisper Large-v3 is the MVP default selected by the project owner; benchmark against ARK-ASR-0.6B on the target laptop before reconsidering |
| Browser | Laya Browser MCP | Chosen candidate; expose tools to Pi through an explicit MCP adapter/extension and verify sampling/tool compatibility |
| Native computer use | `@amaster.ai/pi-computer-use` with its supported CUA runtime | Chosen candidate; verify Windows 11 launch, desktop interaction, permissions, and action results |
| Embeddings | `google/embeddinggemma-2` | Chosen for semantic text retrieval; follow the model card's query/document prompts and format |
| Vector store | ChromaDB | Proposed local store; keep file path and chunk metadata locally |
| TTS | Piper (`OHF-Voice/piper1-gpl`) | Chosen candidate; validate Windows packaging and license implications for any distributed build, and review chosen voice-model license |
| File extraction | pypdf, python-docx, plain-text readers | MVP formats; digital-text PDFs only initially, no OCR guarantee |
| Windows volume | Windows Core Audio wrapper such as Pycaw or a tested native API | Custom tool required; verify the actual value after setting it |
| Global shortcut | Native global key listener in local bridge/helper | Required because a browser-only key handler is unreliable while another app is focused |

### 7.1 Model selection protocol

The STT choice must be made by benchmarking both candidates on identical audio from multiple team members. Measure command correctness, word error rate where a reference transcript is available, latency, CPU/GPU use, and peak memory. Include Indian English accents, application names, technical terms, and numbers such as “thirty percent.”

Gemma 4 E2B is the planned local LLM candidate, but the exact repository/build and inference runtime must be verified during setup. If local tool calls are unreliable or latency is unacceptable, a cloud LLM may be tested as a fallback. Cloud fallback must be opt-in/configured, and the UI must indicate when prompt data leaves the machine.

### 7.2 Laya performance assumption

Laya should be treated as a specialized local browser decision layer, not as a guarantee of sub-100 ms decisions. Its current repository documentation describes model-based decisions that can take seconds on CPU, while deterministic rule steps may be faster. Benchmark browser tasks on the actual Windows laptop, with and without supported GPU acceleration, and report measured results rather than quoting another machine's benchmark as a product guarantee.

## 8. System architecture

### 8.1 Component responsibilities

**React + Vite web UI**
- Renders the listening indicator, transcript, interpreted command, plan, pending approval, result, and history.
- Sends user-facing commands and approval/cancel responses to the local bridge.
- Does not store API keys or run desktop actions directly.

**Native shortcut/audio helper**
- Registers global Alt+M even when the VoicePilot browser window is not focused.
- Captures microphone audio or toggles the local recording service.
- Emits recording state and audio payload/status to the local bridge/STT service.
- Must stop cleanly when VoicePilot exits.

**Node.js/TypeScript bridge**
- Serves the UI API/WebSocket endpoint on loopback only.
- Starts and supervises the Pi RPC process.
- Routes transcript prompts to Pi and translates Pi events to UI events.
- Manages a single active task for the MVP, confirmation state, cancellation, timeouts, and structured audit events.
- Coordinates STT, file search, and TTS services if they run separately.

**Pi agent**
- Maintains conversation state required for short contextual follow-ups.
- Interprets the user's transcript, plans a bounded sequence of permitted actions, and selects tools.
- Returns tool results and user-facing explanations.
- Must not receive an unrestricted shell/PowerShell capability.

**Laya Browser MCP adapter**
- Makes browser automation tools available to Pi using a supported MCP client/extension adapter.
- Owns a dedicated controlled browser session separate from the browser tab displaying VoicePilot's UI.
- Handles supported browser tasks such as search, navigation, click, fill, and page interaction.
- Requires an integration spike to confirm that the chosen Pi setup supports the required MCP tools and any sampling-based escalation path.

**Pi computer-use extension / CUA runtime**
- Handles native applications, windows, keyboard/mouse actions, and supported desktop inspection on Windows.
- Uses only allowed actions and explicit app identifiers where possible.
- Reports the operation result and available evidence to Pi/bridge.

**Local file-search service**
- Indexes user-selected directories; extracts supported document text; chunks and embeds it with `google/embeddinggemma-2`; retrieves relevant chunks with ChromaDB.
- Returns short excerpts, source paths, result IDs, and match metadata.
- Never treats document contents as executable instructions.

**STT and TTS services**
- STT transcribes an audio recording into text and returns model/latency metadata.
- Piper TTS speaks a short response or status when enabled; text feedback remains the primary accessible fallback.

### 8.2 Architecture diagram

```text
Global Alt+M + microphone
        |
        v
STT service (faster-whisper or ARK, selected by benchmark)
        |
        v
React UI <---- WebSocket/HTTP ----> Node.js/TypeScript bridge
                                         |
                                         v
                                      Pi RPC
                                         |
                         +---------------+----------------+
                         |               |                |
                         v               v                v
                  Laya Browser MCP   CUA desktop tools   File-search tool
                  (controlled web)  (Windows 11)        (EmbeddingGemma 2)
                         |               |                |
                         +---------------+----------------+
                                         |
                                         v
                              policy -> execute -> verify
                                         |
                                         v
                                  Result and history
                                         |
                                    optional Piper TTS
```

### 8.3 Deployment model

All services run on the target Windows 11 machine for the hackathon. The web UI is opened at a loopback address such as `http://127.0.0.1:<port>`. The bridge, STT/model services, Pi process, controlled browser, and file index remain local unless a clearly configured cloud provider is used. Do not expose the bridge to the local network by default.

## 9. End-to-end interaction flows

### 9.1 Simple desktop command

1. User presses Alt+M; the UI shows **Listening**.
2. User says “Set the volume to thirty percent.”
3. User presses Alt+M again; the UI shows **Transcribing**.
4. STT returns a transcript and the UI displays it.
5. Pi maps it to `set_volume(level=30)`.
6. Policy validates the numeric range and classifies the action as low-risk.
7. The volume tool changes the master output level and reads it back.
8. The UI shows success only if the read-back confirms the target within a small tolerance.
9. Optional Piper TTS says “Volume set to 30 percent.”

### 9.2 Multi-step browser command

Example: “Open Chrome, search for TinyViT federated learning, then scroll down.”

1. STT transcribes the request.
2. Pi creates a structured plan of supported actions.
3. The bridge validates the plan and ensures all steps are in the allowlist.
4. Laya controls the dedicated browser session for the search/page operation; native desktop control is used only if needed.
5. Each action result is returned separately.
6. The UI shows each step as pending, running, succeeded, or failed.
7. If a step fails, stop or ask before continuing if later steps depend on it. Report partial completion truthfully.

### 9.3 Semantic file search

Example: “Find my notes about federated learning and TinyViT.”

1. Pi calls `search_files(query, top_k=5)`.
2. File-search service embeds the query using the model's recommended search-query format.
3. ChromaDB retrieves candidate chunks from the index of user-approved folders. Exact filename matches may also contribute to ranking.
4. Results include stable result IDs, display names, paths, snippets, and relevance information.
5. UI presents the ranked results.
6. “Open the first result” resolves to a previously returned result ID. The file-opening tool re-validates that the path remains inside an approved root before opening it.

### 9.4 Confirmation and cancellation

1. The policy layer identifies an action that requires confirmation.
2. The current execution pauses and a structured approval request is sent to the UI.
3. User selects **Approve**, **Decline**, or **Cancel task**.
4. Approval is tied to the pending action ID and expires after a configured timeout. A decline or timeout must not execute the action.
5. If approved, the bridge re-validates the action before execution; it does not blindly trust the prior LLM plan.

## 10. Functional requirements

Priority labels: **M** = must-have for MVP; **S** = should-have if time allows; **C** = stretch/consider later.

### FR-01 — Voice capture and shortcut (M)
- Global Alt+M toggles recording on and off.
- The shortcut works while another application is foregrounded, subject to OS permissions.
- UI states: Ready, Listening, Transcribing, Thinking, Awaiting approval, Executing, Success, Error, Cancelled.
- Empty or too-short recordings are rejected with a helpful message.
- Audio is not saved persistently by default.

**Acceptance:** 10 consecutive start/stop cycles succeed; stopping recording produces a transcript or a clear failure state; no orphan recording continues after app exit.

### FR-02 — Speech transcription (M)
- Transcribe command-length speech in the selected benchmarked language/model configuration.
- Return transcript text, duration, and error state.
- Keep the service boundary swappable so STT can be changed without modifying PC tools.
- Support local STT in the selected initial setup; cloud STT may be an explicit alternate configuration only.

**Acceptance:** benchmark dataset records exact transcripts and action intent accuracy for both candidate models; the chosen model meets agreed latency and command accuracy thresholds.

### FR-03 — Pi agent integration (M)
- Run Pi as a supervised RPC process from the local bridge.
- Stream relevant text, tool-call, tool-result, and final-response events to the UI.
- Handle process crashes, timeouts, malformed events, and restart without freezing the UI.
- Maintain short context needed for follow-up commands, with a visible or configurable “new task/reset context” control.

**Acceptance:** 20 sequential prompts are handled without protocol desynchronization; a simulated Pi restart returns the UI to Ready and produces a visible error/notice.

### FR-04 — Open supported application (M)
- Support a configurable allowlist with friendly IDs such as `chrome`, `notepad`, `calculator`, and optionally `vscode` when installed.
- Resolve each ID to a validated launch mechanism/path; never accept arbitrary command strings from the LLM.
- Verify launch by process/window evidence when available.

**Acceptance:** each installed allowlisted application opens; missing applications return a clear error and do not execute a fallback shell command.

### FR-05 — Close application safely (M)
- Request a normal close first (for example, a window close command).
- Ask confirmation when closing could interrupt work, and never force-kill by default.
- If the application refuses to close, report it accurately.

**Acceptance:** declined confirmation prevents closure; application-close failure is not reported as success; forced termination is not part of the MVP tool schema.

### FR-06 — Scroll and navigation (M)
- Support scroll up/down with bounded step sizes.
- Support browser back/forward through browser tools or validated keyboard actions.
- Preserve a clear distinction between browser actions and native desktop actions.

**Acceptance:** direction and bounded amount are respected; invalid directions or oversized amounts are rejected.

### FR-07 — Volume control (M)
- `set_volume(level)` accepts an integer or numeric level in 0–100.
- `toggle_mute()` mutes/unmutes the default output device.
- Verify state after applying the change if the platform API supports read-back.

**Acceptance:** test at 0, 30, 50, and 100 percent; out-of-range values are rejected or clamped according to one documented policy (prefer rejection with a clarification/error).

### FR-08 — Web search and browser navigation (M)
- Accept a query and navigate the controlled browser to a search provider/results page.
- Support browser back/forward and page scrolling.
- Laya tools must act on a dedicated browser session, not the VoicePilot UI tab.
- Restrict navigation schemes; block `javascript:` and unapproved local file URLs. Validate any URLs passed by the model.

**Acceptance:** five different search phrases open results; navigation and scroll operate on the controlled page; the UI page remains usable.

### FR-09 — Structured multi-step plans (S)
- Pi may propose multiple ordered tool calls for a compound request.
- Each step must validate independently and return a structured result.
- Stop or seek direction on a failed dependency; report partial outcomes.
- Enforce a maximum step count for MVP workflows (suggested default: 5).

**Acceptance:** a two- or three-step request executes in order; one simulated failure does not cause the UI to report the entire plan as successful.

### FR-10 — Semantic file indexing (S)
- User selects approved root folders; no entire-drive scan by default.
- Support text extraction from digital PDFs, DOCX, TXT, Markdown, and common source-code/text files.
- Chunk long documents; store file metadata, modification time, chunk ID, and embedding.
- Use `google/embeddinggemma-2` with the model card's query/document prompts. Do not mix vectors produced by incompatible model versions/configurations.
- Re-index a changed file; remove stale records when a file is deleted or removed from an approved root.

**Acceptance:** index at least 20 sample files; a curated set of 10–20 queries returns the expected file in the top five for the agreed benchmark threshold. Search failures are visible and do not crash the agent.

### FR-11 — Open search result safely (S)
- `open_file(result_id)` must accept a result ID returned by a recent search rather than an arbitrary path generated by the LLM.
- Resolve the ID server-side, verify the file still exists, canonicalize its path, and check it is inside an approved root.
- Use the OS association to open the document; report success only when the launch call succeeds and, where possible, a process/open event confirms it.

**Acceptance:** an indexed file opens; a tampered/unknown result ID and a path traversal attempt are rejected.

### FR-12 — Confirmation and cancellation (M)
- Confirmation UI includes the action and relevant target (app/file/site), plus Approve and Decline/Cancel.
- No action that requires approval proceeds while approval is pending.
- Approval expires after a configurable timeout; default 30 seconds.
- Cancellation stops the next step in a multi-step task; it cannot promise to undo an already completed external action.

**Acceptance:** decline, timeout, and cancellation each prevent unexecuted pending actions from running.

### FR-13 — Action history and verification (S)
- History records timestamp, transcript, normalized action, target, outcome, duration, and error code/message.
- Raw audio and full private document contents are not logged.
- A successful result is based on an action-specific signal (API read-back, process/window evidence, browser URL/page state), not the LLM's statement alone.

**Acceptance:** successful, failed, cancelled, and blocked actions are distinguishable in the UI history.

### FR-14 — Piper spoken responses (S)
- TTS is optional and does not block UI updates.
- Speak brief confirmations/errors; avoid reading full file contents automatically.
- Provide mute/disable control.
- Review Piper distribution licensing and the selected voice model license before packaging.

**Acceptance:** enable/disable works, text status remains available if TTS fails, and speech playback does not overlap multiple responses unexpectedly.

### FR-15 — Reusable workflows (C)
- Save an explicitly named and user-approved list of supported tool calls.
- Workflow replay displays the planned sequence and applies the same permission policy as interactive commands.
- No workflow may contain arbitrary code or raw shell commands.

**Acceptance:** a workflow can be saved, listed, replayed, and cancelled without bypassing safety checks.

## 11. Tool contracts and action policy

The LLM must select from predefined tools with typed arguments. Use a schema library (for example, Zod in Node or Pydantic in Python) to validate all input. The bridge re-validates every action immediately before execution.

### 11.1 Suggested tool set

| Tool | Required parameters | Default policy |
|---|---|---|
| `open_app` | `app_id` from allowlist | Execute; report result |
| `close_app` | `app_id` | Confirmation where interruption is possible; normal close only |
| `scroll_window` | `direction`, `amount` | Execute with bounds |
| `set_volume` | `level` 0–100 | Execute and read back |
| `toggle_mute` | none | Execute and read back when possible |
| `search_web` | `query` | Execute in controlled browser |
| `browser_back` | none | Execute in controlled browser |
| `browser_forward` | none | Execute in controlled browser |
| `browser_scroll` | `direction`, `amount` | Execute in controlled browser with bounds |
| `search_files` | `query`, optional `top_k` | Search approved roots and return result IDs |
| `open_file` | `result_id` | Validate ID/root; then open |
| `get_active_context` | optional | Read only; expose only minimal necessary window metadata |

### 11.2 Prohibited capabilities for MVP

- General-purpose `run_shell(command)` or `run_powershell(command)` tool.
- Arbitrary Python execution.
- Arbitrary file delete/move/overwrite actions.
- Administrator/elevation prompts or security-setting changes.
- Unbounded clicking, typing, scrolling, or action loops.
- Opening arbitrary local paths supplied by model output.

### 11.3 Structured action example

```json
{
  "action": "set_volume",
  "parameters": { "level": 30 },
  "reason": "User explicitly requested a volume level",
  "requires_confirmation": false
}
```

This object is an example of the application's normalized action contract, not a direct instruction to trust a model-provided confirmation flag. The policy layer determines confirmation requirements independently.

### 11.4 Result contract

Each tool returns a typed result containing at least:

- `action_id`
- `status`: `succeeded`, `failed`, `blocked`, `cancelled`, or `needs_confirmation`
- `summary`
- `started_at`, `completed_at`, and elapsed duration if available
- `evidence`: safe minimal facts supporting verification (for example, read-back volume level or opened window title)
- `error_code` and a user-safe error message when applicable

## 12. Voice, model, and retrieval requirements

### 12.1 STT benchmark

Create a small local benchmark set of approximately 20–30 commands, recorded by several team members under consistent conditions. Include:
- App names (Chrome, Notepad, VS Code, Calculator).
- Technical terms such as TinyViT and federated learning.
- Numerics and percentages (30%, 50%, 100%).
- Similar-sounding words and varied phrasing.
- Quiet room recordings plus a small noisy-room sample.

For faster-whisper Large-v3 and ARK-ASR-0.6B, record: reference text, hypothesis text, command-intent correctness, end-of-recording-to-transcript latency, peak memory, CPU/GPU utilization, and failure rate. Keep an interface that allows switching models without changing the rest of the app.

### 12.2 LLM/tool-calling qualification

Before integrating all UI features, test the Gemma 4 E2B candidate on at least these cases:
- Exact one-step requests.
- Compound requests with two or three actions.
- Ambiguous requests that should trigger a question.
- Unsupported requests that should be rejected.
- Invalid/missing tool arguments.
- Malicious instructions contained in file text or a web page.
- Tool error followed by a truthful user-facing explanation.

If the candidate cannot reliably use the required tools in the selected Pi runtime, test a compatible cloud model as a configured fallback. Do not let fallback silently transmit data; show provider state and document the privacy implications.

### 12.3 EmbeddingGemma 2 retrieval

- Model identifier: `google/embeddinggemma-2`.
- Use the recommended Sentence Transformers/model-card task prompts for search queries and documents (for example, the model's SearchQuery and Document prompt configurations); use title-plus-content formatting where applicable.
- Use the model's default vector dimension initially. Consider truncation or alternate precision only after validating retrieval quality and storage/performance impact.
- Store model name/version, vector dimension, text extraction version, chunking settings, and indexed file modification times.
- Rebuild the index when model or embedding configuration changes; do not compare new query vectors to old vectors from an incompatible configuration.
- Return a short matching excerpt and the filename; avoid sending full document contents to Pi unless the user requests it and the integration requires it.

### 12.4 TTS behavior

- Piper speaks concise status messages such as “Volume set to 30 percent” or “I couldn't find a matching file.”
- TTS is asynchronous and must not delay state updates.
- No speech output is played while the user is recording unless explicitly intended.
- Read the license of Piper implementation and the selected voice assets before distribution; voices can have their own terms.

## 13. UX and accessibility requirements

### 13.1 Main screen

The first screen should make the status immediately obvious. It contains:
- Product name and connection/agent status.
- Large microphone/listening indicator and Alt+M hint.
- Current transcript.
- Interpreted command/plan with ordered steps.
- Confirmation panel when an action requires approval.
- Per-step execution status and final result.
- Recent history and a way to clear/reset context.
- File-search results with filename, relative path, short snippet, and Open action.

### 13.2 States

- **Ready:** waiting for user.
- **Listening:** microphone active; show a clear indicator.
- **Transcribing:** recording ended; speech model processing.
- **Planning:** Pi is interpreting/choosing tools.
- **Awaiting approval:** actions are paused.
- **Executing:** show current step.
- **Succeeded:** show verified outcome.
- **Partially succeeded:** some steps worked and a later step failed/cancelled.
- **Failed/Blocked:** explain what happened without falsely claiming success.
- **Cancelled:** confirm that remaining steps will not run.

### 13.3 UX principles

- Light, modern, readable, not visually “futuristic” or over-animated.
- Clear text feedback remains available even if Piper fails.
- Buttons, statuses, and confirmation actions must be keyboard-accessible.
- Use a visible recording indicator and immediate stop behavior.
- Avoid displaying raw stack traces to users; store diagnostic details separately without secrets.
- Show which provider is processing speech and whether cloud services are enabled.
- Keep the VoicePilot UI browser window separate from the browser context controlled by Laya.

## 14. Security, privacy, and safety

### 14.1 Local service security

- Bind the bridge to `127.0.0.1` only by default.
- Restrict WebSocket/HTTP origins to the VoicePilot UI origin; use a per-session token or equivalent local request protection where practical.
- Keep API keys in environment variables or OS secret storage; never embed them in the React bundle or source control.
- Validate payload size and schema for all bridge requests.
- Restrict browser navigation to approved schemes; block `javascript:` and unapproved local-file navigation.
- Run the app without administrator privileges.

### 14.2 Model and prompt injection

- Treat webpage text, document content, filenames, search snippets, and model output as untrusted input.
- A webpage or document must not be allowed to change tool permissions or instruct the agent to ignore policy.
- The action policy is deterministic code and is not controlled by the LLM.
- Tool output must be sanitized before presentation; avoid rendering untrusted HTML directly.

### 14.3 File boundaries

- User explicitly selects folders to index.
- Canonicalize paths; reject traversal, symlink escapes, unapproved roots, and stale/unknown result IDs.
- Only open files that were returned by a recent search or explicitly selected by the user.
- Do not index hidden/system directories by default.
- Store vectors and metadata locally. Do not upload full files by default.

### 14.4 Action policies

- Low risk: set volume, mute/unmute, bounded scroll, web search, browser back/forward — may run directly after validation.
- Moderate risk: launch an allowlisted app or open a file from approved roots — run with clear status; optional confirmation setting.
- Potentially disruptive: close an app, close a browser tab containing work, or a multi-step action whose target is uncertain — confirmation required.
- Prohibited for MVP: delete data, overwrite files, shutdown/restart, elevate privileges, modify security settings, run arbitrary shell/code.

### 14.5 Logging and audio privacy

- Do not persist raw audio by default.
- Store transcripts and action summaries only as needed for visible history; provide clear-history control.
- Never log API keys, raw audio, or full document text by default.
- When a cloud STT/LLM is used, show a visible disclosure before or at first use and document what data is transmitted.
- File-content snippets sent to an LLM must be minimized and only transmitted when needed. Prefer local retrieval and local LLM processing where practical.

## 15. Performance and quality targets

These are project acceptance targets to measure on the actual Windows laptop, not promises before benchmarking.

| Metric | Initial target | How to measure |
|---|---|---|
| Global hotkey responsiveness | UI state changes within 250 ms in normal conditions | 20 start/stop cycles with timestamped events |
| Short-utterance STT latency | p50 ≤ 3 s and p95 ≤ 6 s after recording stops, if hardware permits | Same 20–30 sample benchmark |
| Simple voice-to-action latency | p50 ≤ 5 s from end of speech to verified result | Volume/open-app test set |
| Compound command reliability | ≥ 85% complete success across 20 scripted compound commands in the demo environment | Repeated integration run, count partial failures separately |
| Simple command success | ≥ 90% correct action on the curated command set | Test transcript + action outcome, not WER alone |
| Safety | 100% of test cases that require approval remain blocked until approval; 0 prohibited actions execute | Automated policy tests and live manual tests |
| File retrieval | Expected file appears in top 5 for ≥ 80% of curated queries | Prepare 10–20 queries with known correct target files |
| UI responsiveness | No frozen UI during STT/LLM/TTS calls | Stress test on target machine and inspect event updates |
| Task recovery | Failed tool result produces visible failure and no false success | Inject errors for every tool category |

If a model misses the latency target, first test supported GPU acceleration, quantization, context configuration, and smaller candidate models. Do not disguise slow inference with optimistic UI messages. Show that the agent is working and provide cancellation when possible.

## 16. Testing and acceptance plan

### 16.1 Unit tests

- Input schema validation for each tool.
- App allowlist resolution.
- Volume boundary validation.
- Scroll bounds and direction validation.
- File result-ID lookup and canonical-path/root checks.
- Confirmation expiration/decline behavior.
- Result state transitions and error mapping.
- Embedding configuration consistency and stale-index handling.

### 16.2 Integration tests

- Hotkey → audio → STT → Pi → action → verified result.
- Pi RPC event stream → bridge → React UI status update.
- Pi invokes a desktop tool and receives the result.
- Pi invokes Laya browser tools through the planned adapter.
- File query → EmbeddingGemma 2 → ChromaDB → result UI → open-file tool.
- Piper TTS output does not block UI.
- Process restart/recovery and service-unavailable states.

### 16.3 Manual demo checklist

- [ ] Alt+M begins and ends recording even while another application is active.
- [ ] Open Notepad or Chrome by voice.
- [ ] Set volume to 30% and verify it.
- [ ] Mute and unmute audio.
- [ ] Scroll and navigate browser history.
- [ ] Perform a web search in the controlled browser.
- [ ] Search approved local folders by semantic meaning.
- [ ] Open the first result by voice.
- [ ] Execute a two-step request and show each step status.
- [ ] Decline a confirmation and verify the action does not happen.
- [ ] Force a controlled failure and show honest recovery messaging.
- [ ] Complete the core demo twice without restarting VoicePilot.

## 17. Delivery plan and team responsibilities

### 17.1 Four-person ownership

| Team member | Ownership | Deliverables |
|---|---|---|
| Member 1 — Voice | Global hotkey, audio capture, STT comparison, transcript payload | Working Alt+M loop and model benchmark table |
| Member 2 — Agent/integration | Node bridge, Pi RPC, Gemma runtime, Laya MCP adapter | Typed command flow and visible tool events |
| Member 3 — Windows/tools | Pi computer-use extension, application control, scroll, volume, safety policies | Working Windows action tools and verification evidence |
| Member 4 — UX/retrieval/QA | React UI, confirmation/history components, EmbeddingGemma index, test/demo coordination | Polished web UI, file search UI, acceptance checklist |

All team members should use agreed interface contracts from hour one. Work can proceed in parallel with mock transcripts and mock tool results. No component owner should wait until the final integration window to expose a testable function.

### 17.2 Suggested 18-hour plan

| Elapsed time | Milestone | Exit condition |
|---|---|---|
| 0–1 hour | Foundation | Repo, environment, tool contracts, Pi extension launched |
| 1–4 hours | Parallel module work | STT returns text; Pi opens Notepad; UI renders statuses |
| 4–7 hours | Vertical slice | Speak → transcribe → Pi → PC action → result works end to end |
| 7–10 hours | Core actions and safety | App, scroll, volume, web search, confirmation and failure behavior work |
| 10–13 hours | Differentiator | Multi-step task and small-scope semantic file search integrated |
| 13–16 hours | Polish and regression | Acceptance checklist, UI polish, model performance measured |
| 16–18 hours | Freeze and rehearse | Reproducible startup, demo script rehearsed twice, backup path ready |

For a 12-hour deadline, deprioritize Piper and semantic indexing until the P0 end-to-end loop is stable. For a 24-hour window, use the additional time to benchmark STT, improve semantic retrieval, test failure cases, and rehearse—not to expand the action scope indiscriminately.

## 18. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| CUA/runtime integration fails on target Windows | High | Day-one spike: open Notepad and inspect a window before building the whole UI |
| Pi RPC and custom MCP extension integration is unclear | High | Test one tool from Pi through the adapter early; do not assume MCP servers are automatically available in every Pi mode |
| Gemma local tool calls unreliable or slow | High | Create a small qualification set; support a configured cloud fallback only if allowed and disclosed |
| STT misrecognizes accent, app names, or numerics | High | Compare both STT candidates on team recordings; optimize for action accuracy |
| Laya does not meet speed expectations | Medium | Benchmark on real sites and the actual GPU/CPU; use deterministic browser paths for simple actions where appropriate |
| Browser UI and agent browser interfere | Medium | Use a separate controlled browser context for Laya |
| Global shortcut only works while UI focused | High | Implement OS-level global hook in local helper/bridge and test while Notepad is foregrounded |
| Semantic search returns wrong/stale files | Medium | Re-index changed files, show snippets/paths, validate result IDs, and let the user select result |
| Prompt injection in webpage/document | High | Treat content as untrusted; enforce tool policy in code; no arbitrary command execution |
| Piper license/voice terms unclear | Medium | Review implementation and voice model licenses before redistribution; keep TTS optional if unresolved |
| API/provider outage during demo | Medium | Keep core PC tools local; provide manual/transcript test path and pretested demo commands |
| Scope creep | High | Protect P0 requirements; only pull P1/P2 after complete vertical slice passes tests |

## 19. Suggested repository structure

```text
voicepilot/
├── apps/
│   └── web/                       # React + Vite UI
├── services/
│   ├── bridge/                    # Node.js/TypeScript API, WebSocket, Pi RPC
│   ├── voice/                     # Hotkey/audio/STT adapter (Python or native helper)
│   └── file-search/               # EmbeddingGemma 2 + ChromaDB + extractors
├── extensions/
│   └── pc-control/                # Custom Pi tools/policy adapters
├── config/
│   ├── apps.example.json          # Allowlisted app IDs and launch settings
│   └── .env.example               # Variable names only, no secrets
├── packages/
│   └── contracts/                 # Shared request/event/action schemas
├── tests/
│   ├── unit/
│   ├── integration/
│   └── demo-checklist.md
├── docs/
│   ├── architecture.md
│   └── model-benchmark.md
├── .gitignore
├── README.md
└── LICENSES.md
```

This is a suggested organization, not a requirement to build a large monorepo. If the deadline is tight, keep the same logical separation in fewer folders.

## 20. Demo and pitch storyboard

### 2–3 minute live demo

**0:00–0:20 — Problem and value**  
“VoicePilot turns natural speech into controlled computer actions, with visible confirmation and verification.” Introduce hands-free productivity and accessibility as the use cases.

**0:20–0:50 — Core control**  
Press Alt+M and say “Open Notepad.” Then set volume to 30%. Show transcript and verified status.

**0:50–1:25 — Browser and multi-step agent**  
Say “Search for TinyViT federated learning, then scroll down.” Show the plan, browser interaction, and step results.

**1:25–2:00 — Semantic file search**  
Say “Find my notes about federated learning.” Select/open the relevant result and explain that EmbeddingGemma 2 matches meaning, not only exact filename.

**2:00–2:25 — Safety and verification**  
Demonstrate a confirmation prompt, decline it, and show that the action was blocked. If time permits, show a failed action and honest error state.

**2:25–3:00 — Market and roadmap**  
Describe target users, explain what is genuinely implemented, and name future work (workflow macros, broader app support, multilingual commands). Do not present planned features or unmeasured latency as already achieved.

### Demo reliability rules

- Rehearse twice using the actual demo laptop, mic, network conditions, and browser context.
- Prepare a known set of files and search queries for semantic retrieval.
- Keep a typed/manual trigger to test the agent if the microphone has a temporary issue, but be transparent if using it in front of judges.
- Do not rely on an untested cloud API or a first-time model download during the presentation.
- Reset the app state and close distracting windows before the demo.

## 21. Definition of done

The MVP is done when all of the following are true:

1. A user can press Alt+M to record a command and press Alt+M again to stop, including when another application is foregrounded.
2. The chosen STT model produces usable transcripts on the team's command set and has benchmark results recorded.
3. Pi is connected through RPC and can invoke the selected browser and desktop tools.
4. Open app, safe close, scroll, volume, mute, web search, and browser navigation work on Windows 11.
5. The React UI shows transcript, listening/thinking/execution states, approvals, and results.
6. The system rejects unsupported and disallowed commands and never exposes arbitrary shell execution to the LLM.
7. The file-search P1 feature, if included in the submitted MVP, retrieves files from user-selected folders and validates file opening by result ID and approved root.
8. The system reports actual outcomes and does not claim success based only on LLM text.
9. Privacy disclosure, local-service binding, and key-handling checks pass.
10. The end-to-end demo runs twice consecutively, with all required actions and at least one differentiator, without a restart.

## 22. References and implementation docs

These are implementation references, not endorsements or guarantees of performance. Recheck installation instructions and licenses at implementation time.

1. **Pi RPC documentation:** https://pi.dev/docs/latest/rpc
2. **Pi SDK documentation:** https://pi.dev/docs/latest/sdk
3. **Pi extensions:** https://pi.dev/docs/latest/extensions
4. **Pi computer-use package:** https://pi.dev/packages/@amaster.ai/pi-computer-use
5. **Laya Browser MCP repository:** https://github.com/bala2006/laya-browser-mcp
6. **EmbeddingGemma 2 model card:** https://huggingface.co/google/embeddinggemma-2
7. **Faster-whisper repository:** https://github.com/SYSTRAN/faster-whisper
8. **Piper implementation:** https://github.com/OHF-Voice/piper1-gpl
9. **Piper voice/model guidance:** https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/VOICES.md
10. **Gemma 4 E2B model information:** https://huggingface.co/google/gemma-4-E2B
11. **Chroma documentation:** https://docs.trychroma.com/
12. **React documentation:** https://react.dev/

---

