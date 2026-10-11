import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [audioArgument, ...extraArguments] = process.argv.slice(2);

if (!audioArgument || extraArguments.length) {
  console.error("Usage: npm run transcribe:speech -- <audio-file>");
  process.exitCode = 2;
} else {
  const audioPath = resolve(process.cwd(), audioArgument);
  const envFile = resolve(repoRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  if (!existsSync(audioPath)) {
    console.error(`Audio file not found: ${audioPath}`);
    process.exitCode = 2;
  } else {
    const python = process.env.VOICEPILOT_PYTHON ?? resolve(repoRoot, ".venv", "Scripts", "python.exe");
    const worker = resolve(repoRoot, "services", "speech", "stt_worker.py");
    const workerEnv = { ...process.env };
    const runtimePath = workerEnv.VOICEPILOT_STT_CUDA_RUNTIME;
    if (runtimePath) {
      const pathKey = Object.keys(workerEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
      const currentPath = workerEnv[pathKey];
      workerEnv[pathKey] = `${runtimePath}${currentPath ? `${process.platform === "win32" ? ";" : ":"}${currentPath}` : ""}`;
    }

    const child = spawn(python, [worker], {
      cwd: repoRoot,
      env: workerEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const requestId = randomUUID();
    let stage = "startup";
    let timer;

    const finish = (message, exitCode = 1) => {
      if (stage === "done") return;
      stage = "done";
      clearTimeout(timer);
      if (message) {
        console.error(message);
        process.exitCode = exitCode;
        if (child.exitCode === null) child.kill();
      } else {
        child.stdin.end();
      }
    };

    timer = setTimeout(() => {
      finish(stage === "startup"
        ? "Speech model startup exceeded 10 minutes. Check the model download and Python setup."
        : "Transcription timed out after 3 minutes.");
    }, 600_000);

    child.stderr.on("data", (data) => process.stderr.write(data));
    child.once("error", (error) => finish(`Could not start the speech worker: ${error.message}`));
    child.stdin.on("error", (error) => finish(`Could not send the audio request to the speech worker: ${error.message}`));
    child.once("exit", (code) => {
      if (stage !== "done") finish(`Speech worker exited (${code ?? "unknown"}) before returning a transcript.`);
    });

    lines.on("line", (line) => {
      let record;
      try { record = JSON.parse(line); } catch { return; }

      if (record.type === "startup_error") {
        finish(`Speech worker failed to start: ${record.error ?? "unknown error"}`);
        return;
      }
      if (record.type === "status" && record.status === "loading_model") {
        console.log(`Loading ${record.model ?? "speech model"} on ${record.device ?? "the selected device"}...`);
        return;
      }
      if (record.type === "status" && record.status === "loading_fallback") {
        console.log(`Loading fallback model ${record.model ?? "on CPU"}...`);
        return;
      }
      if (record.type === "ready" && stage === "startup") {
        stage = "transcription";
        clearTimeout(timer);
        timer = setTimeout(() => finish("Transcription timed out after 3 minutes."), 180_000);
        console.log(`Model: ${record.model ?? "unknown"} | Device: ${record.device ?? "unknown"}`);
        child.stdin.write(`${JSON.stringify({ id: requestId, audioPath })}\n`);
        return;
      }
      if (record.type === "runtime_update") {
        console.log(`Speech fallback: ${record.model ?? "unknown"} on ${record.device ?? "unknown"}`);
        if (record.fallbackReason) console.log(`Reason: ${record.fallbackReason}`);
        return;
      }
      if (record.id !== requestId) return;
      if (record.ok !== true) {
        finish(`Transcription failed: ${record.error ?? "unknown error"}`);
        return;
      }

      console.log(`Model: ${record.model ?? "unknown"} | Device: ${record.device ?? "unknown"}`);
      console.log(`Language: ${record.language ?? "unknown"} | Latency: ${record.latencyMs ?? "unknown"} ms`);
      console.log(`Transcript: ${record.text ?? ""}`);
      finish(undefined, 0);
    });
  }
}
