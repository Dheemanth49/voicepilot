import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface SpeechTranscription {
  text: string;
  language?: string;
  languageProbability?: number;
  latencyMs?: number;
  model?: string;
  device?: "cpu" | "cuda";
}

type Pending = { resolve: (value: SpeechTranscription) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Owns one warm, local faster-whisper worker and correlates JSONL requests. */
export class SttClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private starting?: Promise<void>;
  private ready = false;
  private startupFailed = false;
  activeModel?: string;
  activeDevice?: "cpu" | "cuda";
  devicePreference?: "auto" | "cpu" | "cuda";
  backend?: "ctranslate2";
  fallbackReason?: string | null;
  failureReason?: string;

  constructor(private readonly root: string, private readonly spawnWorker: typeof spawn = spawn) {}
  get isReady() { return this.ready; }
  get enabled() { return process.env.VOICEPILOT_STT_ENABLED === "1"; }

  async start(): Promise<void> {
    if (!this.enabled) { this.failureReason = "Voice is disabled. Run setup:speech, then set VOICEPILOT_STT_ENABLED=1 in .env."; return; }
    if (this.ready) return;
    if (this.startupFailed) throw new Error(this.failureReason ?? "Speech recognition failed to start. Restart VoicePilot after fixing the speech setup.");
    if (this.starting) return this.starting;
    this.starting = this.startWorker();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async startWorker(): Promise<void> {
    const python = process.env.VOICEPILOT_PYTHON ?? resolve(this.root, ".venv", "Scripts", "python.exe");
    const script = resolve(this.root, "services", "speech", "stt_worker.py");
    const workerEnv = { ...process.env };
    const runtimePath = workerEnv.VOICEPILOT_STT_CUDA_RUNTIME;
    if (runtimePath) {
      const pathKey = Object.keys(workerEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
      const currentPath = workerEnv[pathKey];
      workerEnv[pathKey] = `${runtimePath}${currentPath ? `${process.platform === "win32" ? ";" : ":"}${currentPath}` : ""}`;
    }
    const child = this.spawnWorker(python, [script], { cwd: this.root, env: workerEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr.on("data", (data: Buffer) => process.stderr.write(`[VoicePilot STT] ${data.toString()}`));
    const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("Speech model startup exceeded 10 minutes. Check model download and Python setup.")), 600_000);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let record: Record<string, unknown>;
        try { record = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (record.type === "ready") {
          clearTimeout(timer);
          this.activeModel = typeof record.model === "string" ? record.model : undefined;
          this.activeDevice = record.device === "cuda" ? "cuda" : record.device === "cpu" ? "cpu" : undefined;
          this.devicePreference = record.devicePreference === "auto" || record.devicePreference === "cpu" || record.devicePreference === "cuda" ? record.devicePreference : undefined;
          this.backend = record.backend === "ctranslate2" ? "ctranslate2" : undefined;
          this.fallbackReason = typeof record.fallbackReason === "string" ? record.fallbackReason : null;
          this.ready = true;
          this.failureReason = undefined;
          resolveReady();
          return;
        }
        if (record.type === "runtime_update") {
          this.activeModel = typeof record.model === "string" ? record.model : this.activeModel;
          this.activeDevice = record.device === "cuda" ? "cuda" : record.device === "cpu" ? "cpu" : this.activeDevice;
          this.devicePreference = record.devicePreference === "auto" || record.devicePreference === "cpu" || record.devicePreference === "cuda" ? record.devicePreference : this.devicePreference;
          this.backend = record.backend === "ctranslate2" ? "ctranslate2" : this.backend;
          this.fallbackReason = typeof record.fallbackReason === "string" ? record.fallbackReason : this.fallbackReason;
          return;
        }
        if (record.type === "startup_error") { clearTimeout(timer); rejectReady(new Error(String(record.error ?? "Speech worker failed to start."))); return; }
        if (typeof record.id === "string") {
          const pending = this.pending.get(record.id);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(record.id);
          if (record.ok === true && typeof record.text === "string") pending.resolve({
            text: record.text,
            ...(typeof record.language === "string" ? { language: record.language } : {}),
            ...(typeof record.languageProbability === "number" ? { languageProbability: record.languageProbability } : {}),
            ...(typeof record.latencyMs === "number" ? { latencyMs: record.latencyMs } : {}),
            ...(typeof record.model === "string" ? { model: record.model } : {}),
            ...(record.device === "cpu" || record.device === "cuda" ? { device: record.device } : {}),
          });
          else pending.reject(new Error(typeof record.error === "string" ? record.error : "Transcription failed."));
        }
      });
      child.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
      child.once("exit", (code) => {
        this.ready = false;
        this.activeModel = undefined;
        this.activeDevice = undefined;
        this.devicePreference = undefined;
        this.backend = undefined;
        this.fallbackReason = undefined;
        const error = new Error(`Speech worker exited (${code ?? "unknown"}).`);
        if (!this.ready) rejectReady(error);
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
        this.pending.clear(); this.child = undefined;
      });
    });
    try { await readyPromise; } catch (error) {
      this.failureReason = error instanceof Error ? error.message : "Speech worker failed.";
      this.startupFailed = true;
      await this.stop();
      throw new Error(this.failureReason);
    }
  }

  async transcribe(audioPath: string): Promise<SpeechTranscription> {
    await this.start();
    if (!this.ready || !this.child) throw new Error(this.failureReason ?? "Speech recognition is unavailable.");
    const id = randomUUID();
    return new Promise<SpeechTranscription>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectResult(new Error("Transcription timed out after 3 minutes.")); }, 180_000);
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, audioPath })}\n`, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); rejectResult(error); }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined; this.ready = false; this.activeModel = undefined;
    this.activeDevice = undefined; this.devicePreference = undefined; this.backend = undefined; this.fallbackReason = undefined;
    if (child && child.exitCode === null) { child.stdin.end(); child.kill(); }
  }
}
