# VoicePilot — Design Brief

**Version:** 1.0  
**Status:** Design direction for implementation  
**Product:** VoicePilot desktop voice assistant  
**Platform:** React web UI running locally on Windows 11

## 1. Design objective

Design a calm, polished, demo-friendly interface that makes a voice-controlled computer agent understandable and trustworthy. Users should always know whether the assistant is listening, thinking, awaiting approval, executing, or finished. The interface must not look like a terminal, a generic chatbot, or an overly futuristic cockpit.

### Design statement

**A lightweight desktop control panel that makes computer automation visible, safe, and easy to understand.**

## 2. Target experience

- Desktop-first: target a 1280 × 800 laptop viewport, but remain usable at 1024 px width.
- One primary action: start/stop voice recording.
- The current command and its planned actions are more prominent than previous history.
- Status uses plain language, not opaque technical events.
- Dense logs, raw JSON, model IDs, and debugging controls stay out of the primary view.
- Color never carries the only meaning; combine it with iconography and text.
- UI events update incrementally so long model calls never freeze the interface.

## 3. Visual direction

### 3.1 Brand personality

- Clear, friendly, capable, calm, trustworthy.
- Avoid neon gradients, cyberpunk/glass-heavy aesthetics, excessive animation, and tiny text.
- Use restrained color, rounded panels, subtle borders, readable typography, and a clear hierarchy.

### 3.2 Suggested color tokens

Treat these as starting tokens and validate contrast before finalizing.

| Token | Suggested value | Usage |
|---|---|---|
| `--color-bg` | `#F4F6FA` | Main light page background |
| `--color-surface` | `#FFFFFF` | Main cards and modal surfaces |
| `--color-text` | `#172033` | Primary text |
| `--color-text-muted` | `#64748B` | Hints, timestamps, secondary text |
| `--color-primary` | `#3157D5` | Main action, links, selected controls |
| `--color-primary-hover` | `#2545B3` | Hover/focus treatment |
| `--color-success` | `#0D8B70` | Verified success |
| `--color-warning` | `#A65E00` | Awaiting approval, caution |
| `--color-danger` | `#B4233B` | Blocked/error/destructive confirmation |
| `--color-border` | `#DCE2EC` | Card and input borders |
| `--color-listening` | `#C83D57` | Active microphone state, paired with text/icon |

Use a light theme as the default. A dark theme is optional only after the MVP. Test text and interactive states for WCAG AA contrast where applicable.

### 3.3 Typography and spacing

- Use Inter, system UI, or another readable sans-serif already available to the build.
- Suggested type scale: 28 px page title, 18 px section title, 14–16 px body, 12–13 px metadata (do not use smaller body text).
- 8 px base spacing scale: 8, 16, 24, 32 px.
- Default card radius 12–16 px; button/input radius 8–10 px.
- Use subtle elevation sparingly; prioritize borders and spacing over heavy shadows.

## 4. Information architecture

### Main window

1. **Top bar:** VoicePilot wordmark, current local runtime status, Settings entry point.
2. **Primary voice card:** microphone status, Alt+M hint, start/stop button, short transcript area.
3. **Command plan card:** interpreted request and ordered action steps, each with pending/running/succeeded/failed status.
4. **Results panel:** file search results or browser/task output, depending on the current command.
5. **Activity panel:** latest commands and verified outcomes.
6. **Approval modal:** appears above all content for actions needing user approval.

The MVP may present results and activity as tabs or side panels, but should not introduce unnecessary navigation that hides the live task state.

## 5. Core screen specification

### 5.1 Home / live control

**Header**
- Product name and small “Local agent”/runtime indicator.
- Show cloud processing indicator if the selected STT/LLM sends data off-device.
- Settings icon/link.

**Voice card**
- Large microphone button with label that changes among “Start listening,” “Listening…,” and “Stop recording.”
- Keyboard shortcut helper: “Alt + M”.
- Optional audio level meter, but no distracting animation.
- Live transcript/recognized sentence in readable text.
- Edit transcript affordance before execution if implementation time allows.

**Plan card**
- Header: “What I understood”.
- One-sentence interpretation.
- Ordered steps (maximum default of five in MVP).
- Each step displays action, target, status icon, and result summary.
- Never display an action as complete before executor verification.

**Response area**
- Human-readable final response.
- Retry, cancel, or “Try another command” controls only when relevant.

**Activity/history**
- Timestamp, original transcript, concise task summary, overall status.
- Expand row for step details; do not expose secrets or raw audio.

### 5.2 Approval dialog

Required content:
- Clear question, e.g. “Close Notepad?”
- Target/application.
- Brief reason for approval, e.g. “Unsaved work may be lost.”
- Primary button labelled with the action, e.g. “Close application”.
- Secondary button “Cancel” or “Keep open”.
- Timeout/cancel state must be visible.

Never use a vague “OK” button for a potentially destructive action. Focus should move into the dialog and return to the initiating control when it closes. Keyboard navigation and Escape cancellation must work where cancellation is safe.

### 5.3 File-search results

Each result shows:
- File name and extension.
- Short matching excerpt, with query-relevant wording optionally highlighted.
- Root-relative location rather than unnecessarily exposing a full home-directory path.
- Optional modified time and relevance indicator.
- “Open” control bound to the returned `result_id`.
- No open action when the result no longer exists or resolves outside an approved folder.

### 5.4 Settings (minimal)

- STT model/provider and status.
- LLM/runtime and status.
- Whether audio/text may be sent to a cloud provider.
- Current global shortcut and whether the listener is active.
- Approved indexed folders with add/remove and reindex controls.
- Piper enabled/muted setting and selected voice status.
- Clear activity history and rebuild/clear file index.
- Developer-mode/manual transcript control may be present but hidden behind an explicit development setting.

## 6. Interaction states and microcopy

| State | Label/message | UI treatment |
|---|---|---|
| Ready | “Ready to listen” | Neutral icon, primary microphone action |
| Listening | “Listening… press Alt+M to stop” | Listening color, subtle audio level indicator |
| Transcribing | “Converting speech to text…” | Spinner and cancel if safe |
| Planning | “Understanding your request…” | Keep transcript visible; do not show fake progress percentage |
| Running | “Opening Chrome…” / “Setting volume…” | Current step highlighted |
| Approval | “Allow VoicePilot to close Notepad?” | Modal with action-specific buttons |
| Success | “Volume set to 30%.” | Success icon and verified value |
| Failure | “Chrome could not be opened.” | Concise reason and retry option |
| Unsupported | “I can’t perform that action yet.” | Offer supported alternatives if available |
| Clarification | “Which folder should I search?” | One focused question at a time |
| Cloud request | “This command will be sent to [provider].” | Visible provider disclosure when relevant |

Avoid anthropomorphic claims such as “I definitely did it” until a tool reports success. Use “I couldn’t verify that” when the outcome is uncertain.

## 7. Accessibility and usability

- All actions are keyboard reachable, including the microphone button, result buttons, settings, and dialogs.
- Add visible focus indicators.
- Use semantic HTML buttons/labels and accessible live regions for status changes.
- Listening state is communicated by a label and icon, not only color or animation.
- TTS is optional; text feedback must remain complete without audio.
- Users can cancel recording before submission.
- Avoid rapid flashing and unnecessary motion; respect reduced-motion preferences.
- Keep action results readable without requiring a screenshot or speech-only response.

## 8. Motion and sound

- Animations should be brief and functional: fade/slide state change around 120–200 ms.
- No animation may delay start/stop recording or confirmation controls.
- Optional sound cues for recording start/stop can be configured; avoid playing speech while recording is active.
- Piper must not talk over user input. Queue or suppress a voice response if a new recording starts.

## 9. Responsive behavior

- At 1280 px and above: two-column layout is acceptable (live control/plan primary, activity/results secondary).
- At 1024 px: collapse to a single column or narrower side panel without clipping the transcript or buttons.
- The product is desktop-first; mobile layout is not an MVP requirement.
- Modals must fit the viewport and support keyboard scroll if content grows.

## 10. Component inventory

- `AppShell`
- `TopBar`
- `RuntimeStatusBadge`
- `MicrophoneControl`
- `RecordingStateIndicator`
- `TranscriptPanel`
- `CommandPlan`
- `ActionStepRow`
- `ApprovalDialog`
- `FileSearchResults`
- `ActionResultBanner`
- `ActivityList`
- `SettingsPanel`
- `CloudProcessingDisclosure`
- `ErrorNotice`
- `Toast/Notification`

Keep shared state and transport logic outside presentation components. The UI should render backend events rather than trying to infer whether an action succeeded.

## 11. Design acceptance checklist

- [ ] Users can tell at a glance when the microphone is active.
- [ ] Alt+M is shown somewhere near the microphone control.
- [ ] Transcript and current task remain visible during execution.
- [ ] Each multi-step action has its own status.
- [ ] A pending risky action cannot be mistaken for a completed action.
- [ ] Approve/reject buttons are visually distinct and keyboard accessible.
- [ ] Failure messages are clear and offer a plausible next step.
- [ ] Search results show why a document matched and open only the selected result ID.
- [x] Cloud processing is disclosed where it occurs.
- [ ] Core experience remains usable with Piper disabled.
