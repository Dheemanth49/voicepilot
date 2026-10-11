import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Activity, ArrowUpRight, AudioLines, BrainCircuit, CircleHelp, FileText, Globe2, History, Home, MessageCircle, Mic, Monitor, Send, Settings2, ShieldCheck, Sparkles, Trash2, Volume2 } from "lucide-react";
import type { ApprovalDecision, ApprovalRecord, HealthResponse, TaskEvent, TaskResponse } from "../../../packages/contracts/src/index";

const bridgeUrl = import.meta.env.VITE_BRIDGE_URL ?? "http://127.0.0.1:8787";

type FileRoot = { root_id: string; canonical_path: string; display_name: string; enabled: number; indexed_file_count: number; indexed_chunk_count: number };
type FileResult = { resultId: string; fileName: string; extension: string; rootRelativePath: string; snippet: string; modifiedAt: string; score: number };
type TranscriptionInfo = { language?: string; latencyMs?: number; model?: string; device?: "cpu" | "cuda"; endToEndMs: number };

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [bridgeReachable, setBridgeReachable] = useState(false);
  const [command, setCommand] = useState("");
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [tasks, setTasks] = useState<TaskResponse[]>([]);
  const [approval, setApproval] = useState<ApprovalRecord | null>(null);
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingTask, setCancellingTask] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fileRoots, setFileRoots] = useState<FileRoot[]>([]);
  const [folderPath, setFolderPath] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [fileSearchSearched, setFileSearchSearched] = useState(false);
  const [fileSearchBusy, setFileSearchBusy] = useState(false);
  const [fileSearchError, setFileSearchError] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionInfo, setTranscriptionInfo] = useState<TranscriptionInfo | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const lastHotkeyRevisionRef = useRef<number | null>(null);
  const startingRecordingRef = useRef(false);
  const pendingChatSpeechRef = useRef(new Set<string>());
  const spokenChatTasksRef = useRef(new Set<string>());
  const indexedChunkCount = fileRoots.reduce((total, root) => total + (root.indexed_chunk_count ?? 0), 0);
  const browserTtsReady = typeof window !== "undefined"
    && typeof window.speechSynthesis !== "undefined"
    && typeof SpeechSynthesisUtterance !== "undefined";

  useEffect(() => {
    if (!task || task.status === "executing") return;
    if (task.mode !== "chat" || !task.result) {
      pendingChatSpeechRef.current.delete(task.taskId);
      return;
    }
    if (!pendingChatSpeechRef.current.has(task.taskId) || spokenChatTasksRef.current.has(task.taskId)) return;
    pendingChatSpeechRef.current.delete(task.taskId);
    spokenChatTasksRef.current.add(task.taskId);
    if (!browserTtsReady) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(task.result));
  }, [task, browserTtsReady]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${bridgeUrl}/api/health`);
        if (!response.ok) throw new Error("Bridge unavailable");
        const result = (await response.json()) as HealthResponse;
        if (mounted) {
          setHealth(result);
          setBridgeReachable(true);
          const historyResponse = await fetch(`${bridgeUrl}/api/history`);
          if (historyResponse.ok) {
            const historyResult = (await historyResponse.json()) as { tasks?: TaskResponse[] };
            if (mounted) setTasks(historyResult.tasks ?? []);
          }
          const approvalsResponse = await fetch(`${bridgeUrl}/api/approvals`, { cache: "no-store" });
          if (approvalsResponse.ok) {
            const approvalResult = await approvalsResponse.json() as { approvals?: ApprovalRecord[] };
            if (mounted) setApproval(approvalResult.approvals?.[0] ?? null);
          }
        }
      } catch {
        if (mounted) {
          setHealth(null);
          setBridgeReachable(false);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen || !bridgeReachable) return;
    setFileSearchError("");
    void loadFileRoots();
  }, [settingsOpen, bridgeReachable]);

  useEffect(() => {
    if (health?.components.stt === "available") {
      setRequestError((current) => current === "Local speech recognition is not ready. Finish speech setup, enable it in .env, and wait for the model to load." ? "" : current);
    }
  }, [health?.components.stt]);

  useEffect(() => {
    const onHotkey = (event: KeyboardEvent) => {
      if (!event.repeat && event.altKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        void toggleRecording();
      }
    };
    window.addEventListener("keydown", onHotkey);
    return () => window.removeEventListener("keydown", onHotkey);
  }, [recording, transcribing, submitting, health?.components.stt]);

  useEffect(() => () => {
    if (recordingTimerRef.current !== null) window.clearTimeout(recordingTimerRef.current);
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  useEffect(() => {
    let active = true;
    let polling = false;
    const pollHotkey = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch(`${bridgeUrl}/api/hotkey/state`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { revision?: number };
        if (!active || typeof data.revision !== "number") return;
        const previous = lastHotkeyRevisionRef.current;
        lastHotkeyRevisionRef.current = data.revision;
        if (previous !== null && data.revision > previous && (data.revision - previous) % 2 === 1) void toggleRecording();
      } catch {
        // The regular health poll reports bridge connectivity to the user.
      } finally {
        polling = false;
      }
    };
    void pollHotkey();
    const timer = window.setInterval(() => void pollHotkey(), 400);
    return () => { active = false; window.clearInterval(timer); };
  }, [recording, transcribing, submitting, health?.components.stt]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    const connect = () => {
      if (!active) return;
      const endpoint = new URL("/ws", bridgeUrl);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(endpoint);
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as TaskEvent;
          const approvalRecord = event.data?.approval as ApprovalRecord | undefined;
          if (event.type === "approval.required" && approvalRecord?.status === "pending") setApproval(approvalRecord);
          if (event.type === "approval.resolved" && approvalRecord) {
            setApproval((current) => current?.approvalId === approvalRecord.approvalId ? null : current);
            if (approvalRecord.status === "rejected" || approvalRecord.status === "expired") {
              setRequestError(approvalRecord.status === "rejected" ? "The requested application launch was declined." : "The application launch approval expired.");
            }
          }
          const item = event.data?.task as TaskResponse | undefined;
          if (!item || typeof item.taskId !== "string") return;
          setTask(item);
          setTasks((current) => [item, ...current.filter((taskItem) => taskItem.taskId !== item.taskId)].slice(0, 50));
        } catch {
          // Ignore malformed frames; the task-status poll remains the recovery path.
        }
      };
      socket.onclose = () => {
        if (active) reconnectTimer = window.setTimeout(connect, 1500);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      active = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  async function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = command.trim();
    if (!text || submitting) return;
    if (browserTtsReady) window.speechSynthesis.cancel();
    setSubmitting(true);
    setRequestError("");
    setTask({ taskId: "pending", status: "executing", transcript: text, createdAt: new Date().toISOString() });
    let acceptedTask = false;
    try {
      const response = await fetch(`${bridgeUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { type: "text", text }, source: "ui" }),
      });
      const result = (await response.json()) as TaskResponse | { error?: { message?: string } };
      if (!response.ok) {
        const taskError = "error" in result ? result.error : undefined;
        const message = typeof taskError === "string" ? taskError : taskError?.message;
        throw new Error(message || "The task could not be completed.");
      }
      acceptedTask = true;
      let current = result as TaskResponse;
      pendingChatSpeechRef.current.add(current.taskId);
      setTask(current);
      setTasks((items) => [current, ...items.filter((item) => item.taskId !== current.taskId)].slice(0, 50));
      setCommand("");
      while (current.status === "executing") {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        const statusResponse = await fetch(`${bridgeUrl}/api/tasks/${encodeURIComponent(current.taskId)}`, { cache: "no-store" });
        if (!statusResponse.ok) throw new Error("The task was accepted, but its live status could not be refreshed. Check Recent tasks shortly.");
        current = await statusResponse.json() as TaskResponse;
        setTask(current);
        setTasks((items) => [current, ...items.filter((item) => item.taskId !== current.taskId)].slice(0, 50));
      }
      setCancellingTask(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The task could not be completed.";
      setRequestError(message);
      setCancellingTask(false);
      if (!acceptedTask) {
        setTask((current) => current ? { ...current, status: "failed", error: message, completedAt: new Date().toISOString() } : null);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelTask() {
    if (!task || task.taskId === "pending" || task.status !== "executing" || cancellingTask) return;
    setCancellingTask(true);
    setRequestError("");
    try {
      const response = await fetch(`${bridgeUrl}/api/tasks/${encodeURIComponent(task.taskId)}/cancel`, { method: "POST" });
      const result = await response.json() as TaskResponse | { error?: { message?: string } };
      if (!response.ok) {
        const responseError = "error" in result ? result.error : undefined;
        const error = typeof responseError === "string" ? responseError : responseError?.message;
        throw new Error(error ?? "VoicePilot could not cancel this task.");
      }
    } catch (error) {
      setCancellingTask(false);
      setRequestError(error instanceof Error ? error.message : "VoicePilot could not cancel this task.");
    }
  }

  async function resolveApproval(decision: ApprovalDecision) {
    const current = approval;
    if (!current || resolvingApproval) return;
    setResolvingApproval(true);
    setRequestError("");
    try {
      const response = await fetch(`${bridgeUrl}/api/approvals/${encodeURIComponent(current.approvalId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const result = await response.json() as { approval?: ApprovalRecord; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "VoicePilot could not resolve the approval.");
      setApproval(null);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "VoicePilot could not resolve the approval.");
    } finally {
      setResolvingApproval(false);
    }
  }

  async function clearHistory() {
    if (clearingHistory || tasks.length === 0 || !window.confirm("Clear VoicePilot's saved task history from this PC?")) return;
    setClearingHistory(true);
    try {
      const response = await fetch(`${bridgeUrl}/api/history`, { method: "DELETE" });
      if (!response.ok) throw new Error("Task history could not be cleared.");
      setTasks([]);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Task history could not be cleared.");
    } finally {
      setClearingHistory(false);
    }
  }

  async function loadFileRoots() {
    try {
      const response = await fetch(`${bridgeUrl}/api/file-search/roots`, { cache: "no-store" });
      const data = await response.json() as { roots?: FileRoot[]; error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "Approved folders could not be loaded.");
      setFileRoots(data.roots ?? []);
    } catch (error) {
      setFileSearchError(error instanceof Error ? error.message : "Approved folders could not be loaded.");
    }
  }

  async function addFileRoot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!folderPath.trim() || fileSearchBusy) return;
    setFileSearchBusy(true);
    setFileSearchError("");
    try {
      const response = await fetch(`${bridgeUrl}/api/file-search/roots`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folderPath.trim() }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Folder could not be approved.");
      setFolderPath("");
      setFileResults([]);
      setFileSearchSearched(false);
      await loadFileRoots();
    } catch (error) {
      setFileSearchError(error instanceof Error ? error.message : "Folder could not be approved.");
    } finally {
      setFileSearchBusy(false);
    }
  }

  async function indexFileRoot(rootId: string) {
    if (fileSearchBusy) return;
    setFileSearchBusy(true);
    setFileSearchError("");
    try {
      const response = await fetch(`${bridgeUrl}/api/file-search/roots/${encodeURIComponent(rootId)}/index`, { method: "POST" });
      const result = await response.json() as { indexed?: number; unchanged?: number; removed?: number; failed?: number; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Folder indexing failed.");
      setFileResults([]);
      setFileSearchSearched(false);
      await loadFileRoots();
      setFileSearchError(`Index complete: ${result.indexed ?? 0} updated, ${result.unchanged ?? 0} unchanged, ${result.removed ?? 0} stale removed, ${result.failed ?? 0} failed.`);
    } catch (error) {
      setFileSearchError(error instanceof Error ? error.message : "Folder indexing failed.");
    } finally {
      setFileSearchBusy(false);
    }
  }

  async function removeFileRoot(rootId: string) {
    if (fileSearchBusy) return;
    setFileSearchBusy(true);
    setFileSearchError("");
    try {
      const response = await fetch(`${bridgeUrl}/api/file-search/roots/${encodeURIComponent(rootId)}`, { method: "DELETE" });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Folder could not be removed.");
      setFileRoots((current) => current.filter((root) => root.root_id !== rootId));
      setFileResults([]);
      setFileSearchSearched(false);
    } catch (error) {
      setFileSearchError(error instanceof Error ? error.message : "Folder could not be removed.");
    } finally {
      setFileSearchBusy(false);
    }
  }

  async function searchFiles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fileQuery.trim() || fileSearchBusy) return;
    setFileResults([]);
    setFileSearchSearched(false);
    setFileSearchBusy(true);
    setFileSearchError("");
    try {
      if (indexedChunkCount === 0) {
        throw new Error(fileRoots.length
          ? "No searchable content is indexed yet. Click Index next to an approved folder, then search again."
          : "Approve a folder and click Index before searching.");
      }
      const response = await fetch(`${bridgeUrl}/api/file-search/search`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: fileQuery.trim(), limit: 5 }),
      });
      const result = await response.json() as { results?: FileResult[]; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "File search failed.");
      setFileResults(result.results ?? []);
      setFileSearchSearched(true);
    } catch (error) {
      setFileSearchError(error instanceof Error ? error.message : "File search failed.");
    } finally {
      setFileSearchBusy(false);
    }
  }

  async function openFileResult(resultId: string) {
    setFileSearchError("");
    try {
      const response = await fetch(`${bridgeUrl}/api/file-search/open`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resultId }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "The file could not be opened.");
      setFileSearchError("Opened the selected result.");
    } catch (error) {
      setFileSearchError(error instanceof Error ? error.message : "The file could not be opened.");
    }
  }

  async function toggleRecording() {
    if (submitting || transcribing || startingRecordingRef.current) return;
    if (recording) {
      if (recordingTimerRef.current !== null) window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    setRequestError("");
    setTranscriptionInfo(null);
    if (health?.components.stt !== "available") {
      setRequestError("Local speech recognition is not ready. Finish speech setup, enable it in .env, and wait for the model to load.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRequestError("This browser does not support microphone recording. Use a current version of Edge or Chrome.");
      return;
    }
    startingRecordingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        if (recordingTimerRef.current !== null) window.clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        recorderRef.current = null;
        setTranscribing(true);
        const startedAt = performance.now();
        try {
          const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          const response = await fetch(`${bridgeUrl}/api/audio/transcribe`, {
            method: "POST",
            headers: { "content-type": audio.type.split(";")[0] },
            body: audio,
          });
          const result = await response.json() as { text?: string; language?: string; latencyMs?: number; model?: string; device?: "cpu" | "cuda"; error?: { message?: string } };
          if (!response.ok) throw new Error(result.error?.message ?? "Speech recognition failed.");
          if (!result.text?.trim()) throw new Error("No speech was detected. Try again or type your command.");
          setCommand(result.text.trim());
          setTranscriptionInfo({
            ...(result.language ? { language: result.language } : {}),
            ...(typeof result.latencyMs === "number" ? { latencyMs: result.latencyMs } : {}),
            ...(result.model ? { model: result.model } : {}),
            ...(result.device ? { device: result.device } : {}),
            endToEndMs: Math.round(performance.now() - startedAt),
          });
        } catch (error) {
          setRequestError(error instanceof Error ? error.message : "Speech recognition failed.");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.onerror = () => {
        if (recordingTimerRef.current !== null) window.clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        setRequestError("Microphone recording failed. Check microphone permissions and try again.");
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") {
          setRecording(false);
          recorder.stop();
        }
      }, 180_000);
    } catch (error) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      recorderRef.current = null;
      setRecording(false);
      const name = error instanceof DOMException ? error.name : "";
      const message = name === "NotAllowedError" || name === "SecurityError"
        ? "Microphone access was blocked. Allow microphone access for this site, then try again."
        : name === "NotFoundError"
          ? "No microphone was found. Connect a microphone and try again."
          : name === "NotReadableError"
            ? "The microphone is busy or unavailable. Close other apps using it and try again."
            : error instanceof Error ? error.message : "Microphone access was denied or unavailable.";
      setRequestError(message);
    } finally {
      startingRecordingRef.current = false;
    }
  }

  const piReady = health?.components.pi === "available";
  const sttReady = health?.components.stt === "available";
  const desktopReady = health?.components.desktopTools === "available";
  const systemReady = bridgeReachable && piReady && sttReady && desktopReady;
  const handleCommandKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  const navigate = (section: "home" | "chat" | "files" | "history" | "settings") => {
    if (section === "files" || section === "settings") {
      setSettingsOpen(true);
      return;
    }
    if (section === "chat") document.getElementById("voicepilot-command")?.focus();
    else document.getElementById(section === "history" ? "recent-activity" : "home")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <main className="app-shell" id="home">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="/" aria-label="VoicePilot home">
          <span className="brand-mark"><AudioLines size={29} strokeWidth={2.2} /></span>
          <span className="brand-copy"><strong>Voice<span>Pilot</span></strong><small>Your voice. A more capable computer.</small></span>
        </a>
        <nav className="side-nav">
          <button className="nav-item active" type="button" onClick={() => navigate("home")}><Home size={20} />Home</button>
          <button className="nav-item" type="button" onClick={() => navigate("chat")}><MessageCircle size={20} />Chat</button>
          <button className="nav-item" type="button" onClick={() => navigate("files")}><FileText size={20} />Files</button>
          <button className="nav-item" type="button" onClick={() => navigate("history")}><History size={20} />History</button>
          <button className="nav-item" type="button" onClick={() => navigate("settings")}><Settings2 size={20} />Settings</button>
        </nav>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className={`runtime-pill ${systemReady ? "is-connected" : "is-offline"}`}>
            <span className="status-dot" />
            {systemReady ? "Voice + desktop ready" : bridgeReachable ? "Core setup needs attention" : "Bridge not connected"}
          </div>
          <button className="profile-button" type="button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}>VP</button>
        </header>

        <section className="voice-stage" aria-label="Voice command">
          <div className={`voice-orbit ${recording ? "is-listening" : ""} ${transcribing ? "is-transcribing" : ""}`}>
            <AudioLines className="waveform waveform-left" size={116} strokeWidth={1.2} aria-hidden="true" />
            <button className={`mic-button ${recording ? "recording" : ""}`} type="button" onClick={() => void toggleRecording()} disabled={submitting || transcribing || (!recording && !sttReady)} aria-label={recording ? "Stop recording" : "Start voice recording"} aria-pressed={recording}>
              <Mic size={37} strokeWidth={2.4} />
            </button>
            <AudioLines className="waveform waveform-right" size={116} strokeWidth={1.2} aria-hidden="true" />
          </div>
          <h1>{recording ? "Listening…" : transcribing ? "Transcribing…" : submitting ? "Working on it…" : "What can I help you do?"}</h1>
          <p className="intro">Speak naturally. I can use your apps, browser and files.</p>
          <div className="shortcut-hint">Press <kbd>Alt</kbd><span>+</span><kbd>M</kbd> to start/stop</div>
          {!sttReady && <p className="voice-readiness">Voice input is unavailable right now. You can still type a command.</p>}
        </section>

        <form className="command-form" id="chat" onSubmit={submitCommand}>
              <label className="visually-hidden" htmlFor="voicepilot-command">Type a message or voice command</label>
              <span className="composer-keyboard" aria-hidden="true"><Activity size={19} /></span>
              <textarea id="voicepilot-command" value={command} onChange={(event) => { setCommand(event.target.value); setTranscriptionInfo(null); }} onKeyDown={handleCommandKeyDown} maxLength={2000} placeholder="Type a message or use your voice…" disabled={submitting} rows={1} />
              <button className="composer-send" type="submit" disabled={submitting || !command.trim()} aria-label={submitting ? "Sending command" : "Send command"}>{submitting ? <Activity size={20} /> : <Send size={20} />}</button>
        </form>
        {transcriptionInfo && <p className="speech-transcription-meta composer-meta" aria-live="polite">
          {[
            transcriptionInfo.language ? `Language: ${transcriptionInfo.language}` : undefined,
            `Model: ${transcriptionInfo.model ?? "Whisper"}`,
            transcriptionInfo.device ? (transcriptionInfo.device === "cuda" ? "NVIDIA GPU (CUDA)" : "CPU") : undefined,
            typeof transcriptionInfo.latencyMs === "number" ? `Inference: ${transcriptionInfo.latencyMs} ms` : undefined,
            `End-to-end: ${transcriptionInfo.endToEndMs} ms`,
          ].filter(Boolean).join(" · ")}
        </p>}
        {requestError && <p className="request-error composer-error" role="alert">{requestError}</p>}

        {task && <section className="plan-panel task-panel" aria-live="polite">
            <div className="panel-heading compact">
              <div>
                <p className="section-kicker">Live task</p>
                <h2>{task?.status === "succeeded" ? "Task result" : task?.status === "partially_succeeded" ? "Partially completed" : task?.status === "cancelled" ? "Task cancelled" : "What I understood"}</h2>
              </div>
              {task?.status === "executing"
                ? <button className="cancel-task-button" type="button" onClick={() => void cancelTask()} disabled={cancellingTask}>{cancellingTask ? "Cancelling…" : "Cancel task"}</button>
                : <Sparkles size={19} className="muted-icon" />}
            </div>
            <div className={`empty-plan ${task?.status === "failed" ? "task-failed" : task?.status === "partially_succeeded" ? "task-partial" : task?.status === "cancelled" ? "task-cancelled" : ""}`} aria-live="polite">
              <span className="empty-icon"><CircleHelp size={19} /></span>
              <div>
                <strong>{task ? task.status === "executing" ? "Pi is processing your command" : task.status === "succeeded" ? "Pi finished" : task.status === "partially_succeeded" ? "Some requested work completed" : task.status === "cancelled" ? "Pi stopped before the action completed" : "Task failed" : "Your next task will appear here"}</strong>
                <p>{task?.result ?? task?.error ?? "Submit a typed command to send it through the local bridge and Pi."}</p>
                {task?.actionSteps && task.actionSteps.length > 0 && <ol className="action-step-list" aria-label="Action progress">
                  {task.actionSteps?.map((step) => <li className={`action-step ${step.status}`} key={step.id}>
                    <span className="action-step-dot" aria-hidden="true" />
                    <span>{step.label}</span>
                    <small>{step.status === "running" ? "In progress" : step.status === "completed" ? "Completed" : "Failed"}</small>
                  </li>)}
                </ol>}
              </div>
            </div>
          </section>}

        <section className="dashboard-grid" aria-label="VoicePilot status and activity">
          <section className="activity-panel" id="recent-activity">
            <div className="panel-heading compact">
              <div><h2>Recent Activity</h2></div>
              <div className="activity-tools"><span className="task-count">{tasks.length}</span><button className="text-button" type="button" disabled={clearingHistory || tasks.length === 0} onClick={() => void clearHistory()} aria-label="Clear saved task history">Clear <Trash2 size={13} /></button></div>
            </div>
            {tasks.length ? <div className="activity-list">{tasks.slice(0, 6).map((item) => <article className="activity-entry" key={item.taskId}>
              <div className="activity-item">
                <span className="activity-symbol user-symbol"><Mic size={15} /></span>
                <div className="activity-content"><strong>You said</strong><p>“{item.transcript}”</p></div>
                <time>{new Date(item.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
              </div>
              {item.actionSteps?.map((step) => <div className={`activity-item activity-step ${step.status}`} key={step.id}>
                <span className={`activity-symbol step-symbol ${step.status}`}><Sparkles size={14} /></span>
                <div className="activity-content"><strong>{step.status === "running" ? "Agent is working" : step.status === "completed" ? step.label : `${step.label} failed`}</strong><p>{step.status === "running" ? step.label : step.status === "completed" ? "Action completed" : "Check the task result for details."}</p></div>
                <time>{new Date(step.completedAt ?? step.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
              </div>)}
              {(item.result || item.error || item.status === "cancelled") && <div className="activity-item activity-outcome">
                <span className={`activity-symbol outcome-symbol ${item.status}`}><span aria-hidden="true" /></span>
                <div className="activity-content"><strong>{item.status === "succeeded" ? "Completed" : item.status === "partially_succeeded" ? "Partially completed" : item.status === "cancelled" ? "Cancelled" : "Task failed"}</strong><p>{item.result ?? item.error ?? "Task cancelled before the action completed."}</p></div>
                {item.completedAt && <time>{new Date(item.completedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>}
              </div>}
            </article>)}</div> : <div className="activity-empty">Your recent commands and task updates will appear here.</div>}
          </section>

          <section className="readiness-panel">
            <div className="panel-heading compact">
              <div>
                <h2>System Status</h2>
              </div>
            </div>
            <div className="setup-list">
              <SetupItem icon={<Mic size={19} />} label="Speech-to-Text" detail={[health?.providers?.sttModel ?? "Whisper", health?.providers?.sttRuntime?.device === "cuda" ? "NVIDIA GPU (CUDA)" : health?.providers?.sttRuntime?.device === "cpu" ? "CPU" : undefined].filter(Boolean).join(" · ")} ready={sttReady} pendingLabel={health?.components.stt === "initializing" ? "Loading" : undefined} />
              <SetupItem icon={<BrainCircuit size={19} />} label="Language Model" detail={health?.providers?.llmProvider && health.providers.llmModel ? `${health.providers.llmProvider} · ${health.providers.llmModel}` : "Local first · KiloCode fallback"} ready={piReady} />
              {health?.providers?.llmFallbackReason && <p className="status-runtime">LLM fallback: {health.providers.llmFallbackReason}</p>}
              <SetupItem icon={<BrainCircuit size={19} />} label="Request Routing" detail="Laya local decision model" ready={health?.components.layaRouter === "available"} pendingLabel={health?.components.layaRouter === "initializing" ? "Loading" : undefined} />
              <SetupItem icon={<Globe2 size={19} />} label="Browser Control" detail="Laya · Brave CDP" ready={health?.components.browserTools === "available"} />
              <SetupItem icon={<Monitor size={19} />} label="Desktop Control" detail="Windows computer-use" ready={health?.components.desktopTools === "available"} />
              <SetupItem icon={<FileText size={19} />} label="File Search" detail={[health?.providers?.fileSearchModel ?? "EmbeddingGemma 2", health?.providers?.fileSearchRuntime?.device === "cuda" ? "NVIDIA GPU (CUDA)" : health?.providers?.fileSearchRuntime?.device === "cpu" ? "CPU" : undefined].filter(Boolean).join(" · ")} ready={health?.components.fileSearch === "available"} pendingLabel={health?.components.fileSearch === "initializing" ? "Loading" : undefined} />
              <SetupItem icon={<Volume2 size={19} />} label="Text-to-Speech" detail="General chat only · System voice" ready={browserTtsReady} pendingLabel={!browserTtsReady ? "Not available" : undefined} />
              {health?.providers?.sttRuntime?.fallbackReason && <p className="status-runtime">Speech fallback: {health.providers.sttRuntime.fallbackReason}</p>}
              {health?.providers?.fileSearchRuntime?.fallbackReason && <p className="status-runtime">File-search fallback: {health.providers.fileSearchRuntime.fallbackReason}</p>}
            </div>
          </section>
        </section>

      <footer className="page-footer"><span><ShieldCheck size={14} /> VoicePilot desktop assistant</span><button type="button" onClick={() => setSettingsOpen(true)}>Settings <ArrowUpRight size={13} /></button></footer>
      {settingsOpen && <div className="settings-backdrop">
        <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="file-search-title">
          <div className="panel-heading compact">
            <div><p className="section-kicker">Local file search</p><h2 id="file-search-title">Approved folders</h2></div>
            <button className="icon-button" type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button>
          </div>
          <p className="settings-copy">VoicePilot indexes only folders you add here, and the index stays on this computer. When you search through Pi, matching snippets may be sent to its configured model provider. Use a local model if the content must remain on this PC.</p>
          <form className="settings-form" onSubmit={(event) => void addFileRoot(event)}>
            <label className="transcript-label" htmlFor="approved-folder-path">Folder path</label>
            <div className="settings-inline-form">
              <input id="approved-folder-path" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="C:\\Users\\you\\Documents" disabled={fileSearchBusy} />
              <button className="submit-button" type="submit" disabled={fileSearchBusy || !folderPath.trim()}>Add folder</button>
            </div>
          </form>
          <div className="approved-roots" aria-live="polite">
            {fileRoots.length ? fileRoots.map((root) => <div className="approved-root" key={root.root_id}>
              <span><strong>{root.display_name}</strong><small>{root.canonical_path}</small><small>{root.enabled
                ? root.indexed_chunk_count > 0
                  ? `Indexed · ${root.indexed_file_count} files, ${root.indexed_chunk_count} text chunks`
                  : "Approved · click Index before searching"
                : "Disabled"}</small></span>
              <div className="activity-tools">
                <button className="text-button" type="button" disabled={fileSearchBusy} onClick={() => void indexFileRoot(root.root_id)}>{fileSearchBusy ? "Working…" : "Index"}</button>
                <button className="text-button" type="button" disabled={fileSearchBusy} onClick={() => void removeFileRoot(root.root_id)}>Remove</button>
              </div>
            </div>) : <p className="activity-empty">No folders approved yet.</p>}
          </div>
          <form className="settings-form" onSubmit={(event) => void searchFiles(event)}>
            <label className="transcript-label" htmlFor="file-search-query">Search indexed files</label>
            <div className="settings-inline-form">
              <input id="file-search-query" value={fileQuery} onChange={(event) => {
                setFileQuery(event.target.value);
                setFileResults([]);
                setFileSearchSearched(false);
              }} placeholder="project notes about deployment" disabled={fileSearchBusy} />
              <button className="submit-button" type="submit" disabled={fileSearchBusy || !fileQuery.trim()}>Search</button>
            </div>
          </form>
          {fileSearchError && <p className="settings-message" role="status">{fileSearchError}</p>}
          {fileResults.length > 0 && <div className="file-results" aria-label="File search results">{fileResults.map((result) => <article className="file-result" key={result.resultId}>
            <strong>{result.fileName}</strong><small>{result.rootRelativePath}</small><p>{result.snippet}</p>
            <button className="text-button" type="button" onClick={() => void openFileResult(result.resultId)}>Open file</button>
          </article>)}</div>}
          {fileResults.length === 0 && fileSearchSearched && !fileSearchBusy && <p className="activity-empty">No matching files found in the indexed folders.</p>}
        </section>
      </div>}
      {approval && <div className="approval-backdrop">
        <section className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-description">
          <span className="approval-badge"><ShieldCheck size={16} /> One-time approval</span>
          <h2 id="approval-title">Open {approval.targetLabel}?</h2>
          <p id="approval-description">{approval.reason}</p>
          <p className="approval-expiry">This approval expires at {new Date(approval.expiresAt).toLocaleTimeString()} and can authorize only this action.</p>
          <div className="approval-actions">
            <button type="button" className="approval-deny" disabled={resolvingApproval} onClick={() => void resolveApproval("reject")}>{resolvingApproval ? "Sending…" : "Deny"}</button>
            <button type="button" className="approval-allow" disabled={resolvingApproval} onClick={() => void resolveApproval("approve")}>{resolvingApproval ? "Sending…" : "Approve once"}</button>
          </div>
        </section>
      </div>}
      </div>
    </main>
  );
}

function SetupItem({ icon, label, detail, ready, pendingLabel }: { icon: ReactNode; label: string; detail: string; ready: boolean; pendingLabel?: string }) {
  return (
    <div className="setup-item">
      <span className="setup-icon">{icon}</span>
      <span className="setup-label"><strong>{label}</strong><small>{detail}</small></span>
      <span className={`setup-state ${ready ? "ready" : "pending"}`}>{ready ? "Ready" : pendingLabel ?? "Offline"}</span>
    </div>
  );
}

export default App;

