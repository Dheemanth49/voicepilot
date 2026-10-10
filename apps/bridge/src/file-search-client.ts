import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Owns the optional persistent local Chroma/EmbeddingGemma worker. */
export class FileSearchClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private starting?: Promise<void>;
  private ready = false;
  private startupFailed = false;
  failureReason?: string;
  activeModel?: string;
  activeDevice?: "cpu" | "cuda";
  devicePreference?: "auto" | "cpu" | "cuda";
  backend?: string;
  dtype?: string;
  fallbackReason?: string;

  constructor(private readonly root: string) {}
  get isReady() { return this.ready; }
  get enabled() { return process.env.VOICEPILOT_FILE_SEARCH_ENABLED === "1"; }
  get status() { return this.ready ? "available" as const : this.enabled ? (this.failureReason ? "misconfigured" as const : "initializing" as const) : "unavailable" as const; }

  async start(): Promise<void> {
    if (!this.enabled) { this.failureReason = "File search is disabled. Run npm run setup:file-search, then set VOICEPILOT_FILE_SEARCH_ENABLED=1 in .env."; return; }
    if (this.ready) return;
    // Avoid reloading a large model on each poll after a startup failure. Restarting
    // the bridge clears this state once the reported resource/configuration problem is fixed.
    if (this.startupFailed) throw new Error(this.failureReason ?? "Local file search failed to start. Restart VoicePilot to retry.");
    if (this.starting) return this.starting;
    this.starting = this.startWorker();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  async call(action: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    await this.start();
    if (!this.ready || !this.child) throw new Error(this.failureReason ?? "Local file search is unavailable.");
    const id = randomUUID();
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectResult(new Error("Local file-search operation timed out.")); }, timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, action, ...args })}\n`, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); rejectResult(error); }
      });
    });
  }

  private async startWorker(): Promise<void> {
    const python = process.env.VOICEPILOT_FILE_SEARCH_PYTHON ?? resolve(this.root, ".voicepilot-file-search", "venv", "Scripts", "python.exe");
    const dataDirectory = process.env.VOICEPILOT_DATA_DIR ?? resolve(process.env.APPDATA ?? homedir(), "VoicePilot");
    const child = spawn(python, ["-u", "-m", "services.file_search.worker"], {
      cwd: this.root,
      env: { ...process.env, VOICEPILOT_DATA_DIR: dataDirectory, HF_HOME: process.env.HF_HOME ?? resolve(dataDirectory, "models") },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (data: Buffer) => process.stderr.write(`[VoicePilot file search] ${data.toString()}`));
    const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      let startupSettled = false;
      const timer = setTimeout(() => rejectReady(new Error("EmbeddingGemma startup exceeded 10 minutes. Check the model download and Python setup.")), 600_000);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let record: Record<string, unknown>;
        try { record = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (record.type === "ready") {
          clearTimeout(timer);
          startupSettled = true;
          this.activeModel = typeof record.model === "string" ? record.model : undefined;
          this.setRuntime(record);
          this.ready = true;
          this.failureReason = undefined;
          resolveReady();
          return;
        }
        if (record.type === "runtime") {
          this.setRuntime(record);
          return;
        }
        if (record.type === "startup_error") {
          clearTimeout(timer);
          startupSettled = true;
          rejectReady(new Error(String(record.error ?? "File-search worker failed to start.")));
          return;
        }
        if (typeof record.id !== "string") return;
        const pending = this.pending.get(record.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(record.id);
        if (record.ok === true) pending.resolve(record);
        else pending.reject(new Error(typeof record.error === "string" ? record.error : "Local file search failed."));
      });
      child.once("error", (error) => { clearTimeout(timer); startupSettled = true; rejectReady(error); });
      child.once("exit", (code) => {
        this.ready = false;
        this.activeModel = undefined;
        this.activeDevice = undefined;
        this.devicePreference = undefined;
        this.backend = undefined;
        this.dtype = undefined;
        this.fallbackReason = undefined;
        const error = new Error(`File-search worker exited (${code ?? "unknown"}).`);
        if (!startupSettled) { clearTimeout(timer); rejectReady(error); }
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
        this.child = undefined;
      });
    });
    try { await readyPromise; }
    catch (error) {
      this.failureReason = error instanceof Error ? error.message : "File-search worker failed.";
      this.startupFailed = true;
      await this.stop();
      throw new Error(this.failureReason);
    }
  }

  private setRuntime(record: Record<string, unknown>) {
    this.activeDevice = record.device === "cuda" || record.device === "cpu" ? record.device : undefined;
    this.devicePreference = record.devicePreference === "auto" || record.devicePreference === "cpu" || record.devicePreference === "cuda"
      ? record.devicePreference : undefined;
    this.backend = typeof record.backend === "string" ? record.backend : undefined;
    this.dtype = typeof record.dtype === "string" ? record.dtype : undefined;
    this.fallbackReason = typeof record.fallbackReason === "string" ? record.fallbackReason : undefined;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    this.activeModel = undefined;
    this.activeDevice = undefined;
    this.devicePreference = undefined;
    this.backend = undefined;
    this.dtype = undefined;
    this.fallbackReason = undefined;
    if (child && child.exitCode === null) { child.stdin.end(); child.kill(); }
  }
}
