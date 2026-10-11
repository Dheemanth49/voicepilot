import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { resolve } from "node:path";
import type { ProviderStatus } from "../../../packages/contracts/src/index.js";

export type LayaRoute = "chat" | "browser" | "desktop" | "file_search";
type LayaRequest = { type: "route"; text: string } | { goal: string; start_url: string };
type PendingCall = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class LayaWorkerClient {
  private worker: ChildProcess | undefined;
  private output: Interface | undefined;
  private pending: PendingCall | undefined;
  private busy = false;

  constructor(private readonly projectRoot: string) {}

  async isBrowserConnected(): Promise<boolean> {
    let versionUrl: URL;
    try {
      versionUrl = new URL(process.env.VOICEPILOT_BROWSER_CDP_ENDPOINT ?? "http://127.0.0.1:9222");
      versionUrl.pathname = `${versionUrl.pathname.replace(/\/$/, "")}/json/version`;
      versionUrl.search = "";
    } catch {
      return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetch(versionUrl, { signal: controller.signal });
      if (!response.ok) return false;
      const details: unknown = await response.json();
      if (!details || typeof details !== "object") return false;
      const browser = (details as { Browser?: unknown }).Browser;
      const socket = (details as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
      return typeof browser === "string" && !/headless/i.test(browser)
        && typeof socket === "string" && socket.startsWith("ws://127.0.0.1:");
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  get status(): ProviderStatus {
    const python = resolve(this.projectRoot, ".voicepilot-laya", "venv", "Scripts", "python.exe");
    const worker = resolve(this.projectRoot, "services", "browser", "laya_worker.py");
    return existsSync(python) && existsSync(worker) ? "available" : "unavailable";
  }

  async classify(text: string): Promise<LayaRoute> {
    const result = await this.call({ type: "route", text });
    const route = result.route;
    if (result.ok !== true || (route !== "chat" && route !== "browser" && route !== "desktop" && route !== "file_search")) {
      throw new Error(typeof result.error === "string" ? result.error : "Laya did not return a valid capability route.");
    }
    return route;
  }

  runBrowserTask(goal: string, startUrl: string): Promise<Record<string, unknown>> {
    return this.isBrowserConnected().then((connected) => {
      if (!connected) {
        const endpoint = process.env.VOICEPILOT_BROWSER_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
        throw new Error(`VoicePilot cannot connect to a visible Brave browser at ${endpoint}. Run npm run start:browser, then restart VoicePilot.`);
      }
      return this.call({ goal, start_url: startUrl });
    });
  }

  private call(request: LayaRequest): Promise<Record<string, unknown>> {
    if (this.status !== "available") return Promise.reject(new Error("Laya is not installed. Run npm run setup:laya and restart VoicePilot."));
    if (this.busy) return Promise.reject(new Error("Laya is already processing a request."));
    this.ensureWorker();
    const child = this.worker;
    const stdin = child?.stdin;
    if (!child || child.exitCode !== null || !stdin) return Promise.reject(new Error("The Laya worker could not start."));

    this.busy = true;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        this.busy = false;
        this.resetWorker();
        rejectPromise(new Error("Laya did not finish within five minutes. Check the local model runtime and restart VoicePilot."));
      }, 300_000);
      this.pending = {
        resolve: (value) => { clearTimeout(timer); this.pending = undefined; this.busy = false; resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); this.pending = undefined; this.busy = false; rejectPromise(error); },
        timer,
      };
      try {
        stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error) this.pending?.reject(error);
        });
      } catch (error) {
        this.pending.reject(error instanceof Error ? error : new Error("Could not send a request to Laya."));
      }
    });
  }

  private ensureWorker() {
    if (this.worker && this.worker.exitCode === null) return;
    const python = resolve(this.projectRoot, ".voicepilot-laya", "venv", "Scripts", "python.exe");
    const script = resolve(this.projectRoot, "services", "browser", "laya_worker.py");
    const child = spawn(python, [script], { cwd: this.projectRoot, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    this.worker = child;
    this.output = createInterface({ input: child.stdout! });
    this.output.on("line", (line) => {
      let payload: unknown;
      try { payload = JSON.parse(line); } catch {
        this.pending?.reject(new Error("The Laya worker returned invalid JSON."));
        this.resetWorker();
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        this.pending?.reject(new Error("The Laya worker returned an invalid response."));
        return;
      }
      this.pending?.resolve(payload as Record<string, unknown>);
    });
    child.once("error", (error) => { this.pending?.reject(error); this.resetWorker(); });
    child.once("exit", (code) => {
      if (this.worker !== child) return;
      this.pending?.reject(new Error(`The Laya worker exited${code === null ? "" : ` with code ${code}`}.`));
      this.resetWorker();
    });
  }

  private resetWorker() {
    const child = this.worker;
    this.worker = undefined;
    this.output?.close();
    this.output = undefined;
    if (child && child.exitCode === null) child.kill();
  }

  async stop() {
    if (this.pending) this.pending.reject(new Error("Laya worker stopped."));
    this.resetWorker();
  }
}
