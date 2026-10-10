# VoicePilot — Implementation Plan

**Version:** 1.0  
**Status:** Hackathon execution plan  
**Team:** 4 contributors  
**Target:** Windows 11  
**Estimated remaining delivery window:** 12–24 hours, adjusted to actual time available

## 1. Delivery strategy

Build one complete vertical slice early, then add features in controlled layers. The vertical slice is:

**voice or typed input → transcript → Pi RPC → approved tool → Windows action → verified result → React status**

Do not begin by building all UI screens, benchmarking every model, or integrating all optional features independently. The first acceptance milestone is Pi opening Notepad through the chosen Windows computer-use tool. The second is a text prompt travelling through the bridge and Pi RPC to that tool. The third adds voice.

## 2. Must-have outcomes

### P0 — must be finished
- Pi runs and is controllable through RPC on the Windows demo laptop.
- At least one native desktop tool works, followed by app open/close, scroll, and volume.
- STT integrates end-to-end and Alt+M starts/stops global recording.
- Web search/browser navigation works through a tested browser tool path.
- React UI shows transcript, current state, action status, approvals, and final result.
- Dangerous/unsupported actions cannot bypass validation.
- The team has run and rehearsed the main demo twice.

### P1 — target after P0 is stable
- Laya Browser MCP integrated into Pi through an explicit adapter/extension.
- Semantic file search with EmbeddingGemma 2 and ChromaDB for selected folders.
- Multi-step planning with per-step results.
- Piper TTS and contextual follow-up commands.

### P2 — stretch only
- Save/replay workflows, multilingual commands, screenshot understanding, broad OCR, pause/resume for arbitrary actions, polished offline installer.

## 3. Four-person ownership

| Member | Primary ownership | Deliverables | Integration responsibility |
|---|---|---|---|
| Member 1 — Voice | STT benchmark, microphone/audio, global Alt+M, Piper adapter | `transcribe()` contract, recording events, short TTS output | Connect transcript and status events to bridge |
| Member 2 — Agent/bridge | Node bridge, Pi RPC lifecycle, LLM config, event schemas | Task API, RPC client, structured status/step events | Owns cross-module contract and runs integration tests |
| Member 3 — Desktop/browser tools | Pi computer-use extension, CUA Windows runtime, volume tool, Laya MCP adapter | Tested app/window/scroll/volume/browser tools | Demonstrate real PC actions and enforce tool validation |
| Member 4 — UI/retrieval/QA | React/Vite UI, confirmation/history, EmbeddingGemma 2 index, demo plan | UI states, search results, acceptance checklist | Maintain test commands, fixtures, design consistency, and final rehearsal |

Everyone may contribute code across modules, but each module has one accountable owner. Member 2 owns final contract arbitration to avoid incompatible interfaces.

## 4. Timeline A — 12-hour emergency plan

| Elapsed | Focus | Gate to pass | If gate fails |
|---|---|---|---|
| 0:00–0:45 | Repository, environment, contracts, model downloads started in parallel | All contributors can run their module skeleton | Stop scope additions; use one shared venv/runtime version |
| 0:45–2:00 | Pi + Windows computer-use tool proof; React shell; STT smoke test | Pi opens/inspects Notepad; transcript can be produced | Do not proceed to Laya/semantic search until the native tool works |
| 2:00–4:30 | App open, scroll, volume, search; bridge RPC; basic UI events | Typed prompt through bridge calls one real tool and shows result | Drop animations and secondary screens; debug bridge/tool boundary |
| 4:30–6:30 | STT-to-Pi vertical slice and Alt+M global toggle | Spoken command opens allowlisted app | Use typed transcript as temporary fallback while fixing capture |
| 6:30–8:00 | Confirmation and error/status handling; test volume read-back | Reject/timeout cannot execute protected action; errors are visible | Prioritize safety and accurate status over multi-step intelligence |
| 8:00–9:30 | Browser MCP integration or simpler deterministic browser path | Search/navigation works on demo machine | Use a tested deterministic search URL/browser action; disclose scope accurately |
| 9:30–10:30 | Semantic search quick slice if core stable | One selected-folder PDF/TXT/DOCX search works | Defer semantic search; keep file search out of live demo |
| 10:30–12:00 | Smoke tests, freeze dependencies, rehearse | Demo passes twice consecutively | No new features after freeze |

## 5. Timeline B — 24-hour plan

| Elapsed | Focus | Gate to pass |
|---|---|---|
| 0:00–1:00 | Repo, environments, cross-team contracts | Each owner can start their module |
| 1:00–3:00 | Pi RPC and CUA proof, STT/model smoke tests, UI scaffold | First real desktop action and first transcript |
| 3:00–6:00 | Build core desktop tools and bridge; connect one transcript | Open app, scroll, volume all work through the same route |
| 6:00–8:00 | Global Alt+M and full voice-to-action loop | Talk → transcript → Pi → action → visible outcome |
| 8:00–10:00 | Safety, approval workflow, failure handling | No false-success and no bypassable approval |
| 10:00–12:00 | Laya integration and browser task suite | Browser tools available through Pi and stable on the target machine |
| 12:00–15:00 | Semantic file index and `search_files`/`open_file` | Results are correct for known fixture queries; paths are validated |
| 15:00–17:00 | Gemma tool-use evaluation; add cloud fallback only if needed | Record tool-call reliability and latency; no unreviewed provider switch |
| 17:00–19:00 | Piper TTS, contextual commands, history polish | TTS failure doesn't block UI; contextual flow passes tests |
| 19:00–21:00 | Integration and regressions | All P0 and selected P1 cases pass |
| 21:00–23:00 | Rehearse, benchmark, create backup plan | Demo completes twice without restart |
| 23:00–24:00 | Freeze and package | Install steps, limitations, and model settings documented |

Use only the schedule that matches the actual deadline; don't attempt to “finish” both tracks sequentially.

## 6. Work breakdown by milestone

### M0 — Repository and agreements (first 30–60 minutes)

Tasks:
- Create the repository and branches.
- Put all six project docs in `/docs`.
- Agree on action schema, event envelope, error codes, and service ownership.
- Add `.gitignore` for `.env`, Python environments, model weights, local vector databases, audio captures, and build artifacts.
- Create `.env.example` with variable names only.
- Start model downloads early in parallel; don't block integration on a cold download at the end.

Exit criteria:
- Clean startup instructions exist.
- Each contributor can run one minimal component.
- Main bridge/event contracts are agreed.

### M1 — Native desktop proof

Tasks:
- Install Pi and the selected computer-use extension on the Windows laptop.
- Verify the extension's actual tool list and permissions.
- Open and inspect Notepad via Pi.
- Test a normal close action without force-killing.
- Test scrolling on a known window.
- Implement/test exact volume setter and read-back.

Exit criteria:
- Three desktop actions work from Pi and return meaningful results.
- Any CUA runtime or Windows permission issue is found before UI integration.

### M2 — Bridge and Pi RPC

Tasks:
- Implement Pi subprocess lifecycle through the official TypeScript RPC client.
- Add `POST /api/tasks`, `GET /api/tasks/:id`, and `/ws`.
- Relay task and tool progress events into the shared envelope.
- Start with typed transcript input as the test path.
- Add task timeouts, maximum steps, and one active execution queue.

Exit criteria:
- Typed command → Pi → real tool → result event works end to end.

### M3 — Voice

Tasks:
- Benchmark the selected faster-whisper Large-v3 model against ARK-ASR-0.6B using the same 20+ commands.
- Record reference transcripts, hypothesis, command-intent correctness, latency, memory, and CPU/GPU usage.
- Implement provider-neutral STT adapter.
- Implement global Alt+M helper and clean stop behavior.
- Add empty/failed recording states and repeated-command handling.

Exit criteria:
- Alt+M works when another app is focused.
- A recorded command reaches the same Pi pipeline used by typed input.
- The chosen STT model and test results are written to the repo.

### M4 — Safety and reliable status

Tasks:
- Validate every action and parameter before tool dispatch.
- Implement approval records with expiry and one-use resolution.
- Ensure denial, timeout, or cancel cannot invoke the tool.
- Separate action result from LLM final prose.
- Add action IDs, duration, result, and error codes to history.

Exit criteria:
- Rejected close action does not run.
- Failed tools never appear as successes.
- UI can show partial success for a multi-step task.

### M5 — Browser and file search

Tasks:
- Keep the VoicePilot UI browser separate from Laya's controlled browser context.
- Connect Laya Browser MCP to Pi via a tested adapter or extension.
- Test search, navigation, scroll, click, form interaction only where needed.
- Index only approved folders with EmbeddingGemma 2.
- Add extraction for PDF/DOCX/TXT/Markdown/source text.
- Use stable `result_id` values and enforce approved-root validation on open.
- Track changed-file hashes and delete stale chunks.

Exit criteria:
- Browser search works on target laptop.
- A semantic query finds the expected fixture document and opens it using a result ID.

### M6 — User interface and demo polish

Tasks:
- Implement listening/transcribing/planning/approval/executing/succeeded/failed states.
- Render the transcript, interpretation, step-by-step result, and recent history.
- Build a clean confirmation dialog and accessible keyboard handling.
- Add cloud/local processing disclosure.
- Add Piper as optional background TTS.
- Write a repeatable 2–3 minute demo script and known test files.

Exit criteria:
- A judge can understand what the application heard, intended, executed, and verified without reading logs.

## 7. Model benchmark plan

### STT benchmark
Use a fixed set of at least 20 phrases such as:
- “Open Notepad.”
- “Set volume to thirty percent.”
- “Search for federated learning with TinyViT.”
- “Scroll down a little, then go back.”
- “Find my notes about the GasGuard project.”

Capture for each candidate:
- Reference transcript and recognized transcript.
- Correct intent/slots, especially app names, numeric values, direction, and search query.
- Recording-stop-to-transcript latency.
- CPU/GPU use and peak memory.
- Errors, crashes, and warm/cold startup differences.

### LLM benchmark
Test the exact local Gemma 4 E2B runtime for:
- Selecting correct tool and arguments from short phrases.
- Planning two- or three-step tasks in order.
- Asking a question rather than guessing when ambiguous.
- Refusing unsupported tools.
- Respecting untrusted webpage/document content.

Record tool-call validity, task success, median/p95 latency over repeated runs, and memory use. If local quality is insufficient, test an explicitly configured cloud fallback rather than silently swapping models.

### Laya/browser benchmark
Test at least these tasks:
- Search the web for a phrase.
- Open a link by accessible text.
- Scroll a results page.
- Navigate back.
- Recover from missing/delayed page content.

Record completion rate and median/p95 time. Compare deterministic browser actions to Laya where both can perform the task.

## 8. Risk register and mitigation

| Risk | Severity | Mitigation / fallback |
|---|---|---|
| CUA runtime incompatibility | High | Validate Windows support at M1 before UI polish |
| Gemma tool-calling weak/slow | High | Benchmark early; cloud fallback opt-in or deterministic rules for common actions |
| STT recognizes words but wrong numeric slots | High | Evaluate command-level correctness and confirm uncertain values |
| Pi RPC/MCP integration fails | High | Prove one MCP or desktop tool through Pi early; use a tested custom Pi extension adapter if needed |
| Laya slower than expected | Medium | Use deterministic browser path for basic navigation/search; keep Laya for complex UI decisions |
| Embedding model/index takes too long | Medium | Limit folders/file types/chunk count; defer semantic search if P0 not stable |
| UI blocked by model work | High | Keep inference/tool execution off UI event loop and stream status events |
| TTS delays responses | Low | TTS is optional and asynchronous |
| Approval bypass/false success | High | Enforce policy in bridge and test negative cases |
| External model/API unavailable | Medium | Pre-download models, cache artifacts, and keep typed transcript fallback |
| Scope creep | High | Freeze P0 scope; P2 begins only after repeatable demo |

## 9. Merge and integration rules

- Main branch must always launch the current demo.
- Each module should expose a small, documented interface and a stub/mock mode.
- Use shared action names and schemas from `05-backend-schema.md`.
- Avoid committing large model weights, user documents, voice recordings, API keys, or Chroma databases.
- Integrate at least every 60–90 minutes; don't wait until each contributor “finishes” a full module.
- After any change to Pi configuration, RPC transport, or custom extensions, rerun one desktop action and one browser action.
- Freeze dependencies and model configuration before the final rehearsal.

## 10. Final QA checklist

- [ ] App starts from documented instructions on the demo laptop.
- [ ] Pi RPC starts reliably and exits cleanly.
- [ ] Alt+M works outside the VoicePilot browser window.
- [ ] STT model and latency benchmark are documented.
- [ ] Open app, safe close, scroll, volume, mute, search, and browser navigation pass.
- [ ] Confirmation rejection and timeout do not execute the action.
- [ ] Unsupported tools and invalid parameters are blocked.
- [ ] Browser content cannot alter action policy.
- [ ] File search is restricted to approved roots and open uses result IDs.
- [ ] UI reports real outcomes and supports TTS-disabled operation.
- [ ] Cloud processing is disclosed and credentials aren't in client code.
- [ ] Demo passes twice consecutively without restarting the application.
- [ ] Pitch makes no unsupported claims about speed, accuracy, or offline operation.

## 11. Demo script

1. “Open Notepad.” Show transcript and verified app launch.
2. “Set the volume to 30 percent.” Show read-back value.
3. “Search the web for TinyViT federated learning and scroll down.” Show ordered browser actions.
4. “Find my notes about federated learning.” Show semantic results and open a selected result.
5. Demonstrate a confirmation prompt and reject it; show that no action was executed.
6. Explain the main differentiator: the agent interprets, uses constrained tools, and verifies actions rather than merely producing text.

If any advanced feature is not stable, omit it from the live demo and state it as planned future scope.
