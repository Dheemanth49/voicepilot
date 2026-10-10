import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pythonPath = resolve(projectRoot, ".voicepilot-laya", "venv", "Scripts", "python.exe");
const workerPath = resolve(projectRoot, "services", "browser", "laya_worker.py");
let worker;
let outputLines;
let pendingResponse;

export function createBrowserTool({ fetcher = globalThis.fetch, spawnProcess = spawn, environment = process.env } = {}) {
  return {
    name: "voicepilot_browser_task",
    label: "Browse the web",
    description: "Run the user's currently authorized browser task by attaching Laya to the user's CDP-enabled browser. This does not launch a separate browser. Only use the exact goal and URL from the current VoicePilot request. This first browser slice supports searching, navigation, and opening pages; it does not support form entry.",
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 2000 }),
      start_url: Type.String({ minLength: 8, maxLength: 2000 }),
    }),
    async execute(actionId, input, signal) {
      if (typeof actionId !== "string" || !actionId || typeof input?.goal !== "string" || typeof input?.start_url !== "string") {
        return toolError("VoicePilot received an invalid browser task request.");
      }
      if (typeof environment.VOICEPILOT_APPROVAL_TOKEN !== "string" || environment.VOICEPILOT_APPROVAL_TOKEN.length < 32) {
        return toolError("VoicePilot could not authorize this browser task.");
      }
      if (!exists(pythonPath) || !exists(workerPath)) {
        return toolError("The Laya browser runtime is not installed. Run npm run setup:laya, then restart VoicePilot.");
      }

      const bridgeUrl = (environment.VOICEPILOT_APPROVAL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
      try {
        const response = await fetcher(`${bridgeUrl}/api/internal/browser/authorize`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${environment.VOICEPILOT_APPROVAL_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ actionId, goal: input.goal, start_url: input.start_url }),
          signal,
        });
        const authorization = await readJson(response);
        if (!response.ok || authorization.authorized !== true) {
          return toolError(authorization.message ?? "VoicePilot rejected this browser task.");
        }
        const result = await runWorker({ goal: input.goal, start_url: input.start_url }, signal, spawnProcess);
        if (result.solved !== true) return toolError(result.error ?? `The browser task did not complete: ${result.stopped ?? "no verified completion"}.`);
        return {
          content: [{ type: "text", text: `Browser task completed. ${JSON.stringify(result.summary ?? {})}` }],
          details: { solved: true, goal: input.goal, start_url: input.start_url, steps: result.steps ?? [] },
        };
      } catch (error) {
        const message = error instanceof Error && error.name === "AbortError"
          ? "The browser task was cancelled."
          : error instanceof Error ? error.message : "The Laya browser task failed.";
        return toolError(message);
      }
    },
  };
}

export default function voicePilotBrowserExtension(pi) {
  pi.registerTool(createBrowserTool());
  pi.on("session_shutdown", () => resetWorker());
  process.once("SIGTERM", resetWorker);
  process.once("SIGINT", resetWorker);
  pi.registerCommand("voicepilot-browser", {
    description: "Reports that VoicePilot's browser task tool is registered.",
    handler: (_args, context) => context.ui.notify("VoicePilot browser task tool is registered.", "info"),
  });
}

function runWorker(request, signal, spawnProcess) {
  ensureWorker(spawnProcess);
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      resetWorker();
      rejectPromise(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    if (pendingResponse) {
      rejectPromise(new Error("The Laya worker is already processing a browser request."));
      return;
    }
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pendingResponse?.finish === finish) pendingResponse = undefined;
      callback(value);
    };
    const onAbort = () => {
      finish(rejectPromise, new DOMException("The operation was aborted.", "AbortError"));
      resetWorker();
    };
    const requestSlot = {
      finish,
      resolve: (value) => finish(resolvePromise, value),
      reject: (error) => finish(rejectPromise, error),
    };
    pendingResponse = requestSlot;
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      worker.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error && pendingResponse === requestSlot) requestSlot.reject(error);
      });
    } catch (error) {
      requestSlot.reject(error instanceof Error ? error : new Error("Could not write to the Laya worker."));
    }
  });
}

function ensureWorker(spawnProcess) {
  if (worker && worker.exitCode === null) return;
  const child = spawnProcess(pythonPath, [workerPath], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  worker = child;
  outputLines = createInterface({ input: child.stdout });
  outputLines.on("line", (line) => {
    let result;
    try { result = JSON.parse(line); } catch {
      pendingResponse?.reject(new Error("The Laya worker returned invalid JSON."));
      resetWorker();
      return;
    }
    pendingResponse?.resolve(result);
  });
  child.once("error", (error) => {
    pendingResponse?.reject(error);
    resetWorker();
  });
  child.once("exit", (code) => {
    if (worker !== child) return;
    pendingResponse?.reject(new Error(`The Laya worker exited${code === null ? "" : ` with code ${code}`}.`));
    resetWorker();
  });
}

function resetWorker() {
  const child = worker;
  worker = undefined;
  outputLines?.close();
  outputLines = undefined;
  if (child && child.exitCode === null) child.kill();
}

function exists(path) {
  return existsSync(path);
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

async function readJson(response) {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
