import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { SttClient } from "./stt-client.js";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill() { this.exitCode = 0; this.emit("exit", 0); return true; }
}

test("STT runtime readiness records the actual model device and child-only CUDA PATH", async () => {
  const child = new FakeChild();
  const originalPath = process.env.PATH;
  const originalRuntime = process.env.VOICEPILOT_STT_CUDA_RUNTIME;
  const originalEnabled = process.env.VOICEPILOT_STT_ENABLED;
  process.env.PATH = "original-path";
  process.env.VOICEPILOT_STT_CUDA_RUNTIME = "E:\\VoicePilot\\cuda;c:\\VoicePilot\\cudnn";
  process.env.VOICEPILOT_STT_ENABLED = "1";
  let childPath = "";
  const fakeSpawn = ((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const pathKey = Object.keys(options.env ?? {}).find((key) => key.toLowerCase() === "path");
    childPath = pathKey ? options.env?.[pathKey] ?? "" : "";
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  try {
    const client = new SttClient("E:\\VoicePilot", fakeSpawn);
    const started = client.start();
    child.stdout.write(`${JSON.stringify({ type: "ready", model: "large-v3", device: "cuda", devicePreference: "auto", backend: "ctranslate2", fallbackReason: null })}\n`);
    await started;
    assert.equal(client.activeModel, "large-v3");
    assert.equal(client.activeDevice, "cuda");
    assert.equal(client.devicePreference, "auto");
    assert.equal(client.backend, "ctranslate2");
    assert.equal(client.fallbackReason, null);
    assert.equal(childPath, "E:\\VoicePilot\\cuda;c:\\VoicePilot\\cudnn;original-path");
    assert.equal(process.env.PATH, "original-path");
    child.emit("exit", 0);
    assert.equal(client.activeDevice, undefined);
    assert.equal(client.activeModel, undefined);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalRuntime === undefined) delete process.env.VOICEPILOT_STT_CUDA_RUNTIME; else process.env.VOICEPILOT_STT_CUDA_RUNTIME = originalRuntime;
    if (originalEnabled === undefined) delete process.env.VOICEPILOT_STT_ENABLED; else process.env.VOICEPILOT_STT_ENABLED = originalEnabled;
  }
});
