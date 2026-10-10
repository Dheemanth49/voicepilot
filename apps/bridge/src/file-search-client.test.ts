import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { FileSearchClient } from "./file-search-client.js";

class FailedWorker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;

  kill() {
    this.exitCode = 1;
    this.emit("exit", 1, null);
    return true;
  }
}

class ReadyWorker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;

  kill() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }
}

test("does not repeatedly reload EmbeddingGemma after startup fails", async () => {
  const previousEnabled = process.env.VOICEPILOT_FILE_SEARCH_ENABLED;
  const previousPython = process.env.VOICEPILOT_FILE_SEARCH_PYTHON;
  process.env.VOICEPILOT_FILE_SEARCH_ENABLED = "1";
  process.env.VOICEPILOT_FILE_SEARCH_PYTHON = "unused-python";

  let spawnCount = 0;
  const spawnMock = mock.method(childProcess, "spawn", (() => {
    spawnCount += 1;
    const worker = new FailedWorker();
    queueMicrotask(() => worker.stdout.write('{"type":"startup_error","error":"model could not load"}\n'));
    return worker as never;
  }) as never);
  syncBuiltinESMExports();
  const client = new FileSearchClient("unused-root");

  try {
    await assert.rejects(client.start(), /model could not load/);
    await assert.rejects(client.start(), /model could not load/);
    assert.equal(spawnCount, 1);
  } finally {
    await client.stop();
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    if (previousEnabled === undefined) delete process.env.VOICEPILOT_FILE_SEARCH_ENABLED;
    else process.env.VOICEPILOT_FILE_SEARCH_ENABLED = previousEnabled;
    if (previousPython === undefined) delete process.env.VOICEPILOT_FILE_SEARCH_PYTHON;
    else process.env.VOICEPILOT_FILE_SEARCH_PYTHON = previousPython;
  }
});

test("stores actual file-search runtime metadata and clears it at shutdown", async () => {
  const previousEnabled = process.env.VOICEPILOT_FILE_SEARCH_ENABLED;
  const previousPython = process.env.VOICEPILOT_FILE_SEARCH_PYTHON;
  process.env.VOICEPILOT_FILE_SEARCH_ENABLED = "1";
  process.env.VOICEPILOT_FILE_SEARCH_PYTHON = "unused-python";
  let worker: ReadyWorker;
  const spawnMock = mock.method(childProcess, "spawn", (() => {
    worker = new ReadyWorker();
    queueMicrotask(() => worker.stdout.write(JSON.stringify({
      type: "ready",
      model: "google/embeddinggemma-2",
      device: "cpu",
      devicePreference: "auto",
      backend: "pytorch",
      dtype: "float32",
      fallbackReason: "CUDA initialization failed; using CPU.",
    }) + "\n"));
    return worker as never;
  }) as never);
  syncBuiltinESMExports();
  const client = new FileSearchClient("unused-root");

  try {
    await client.start();
    assert.equal(client.activeDevice, "cpu");
    assert.equal(client.devicePreference, "auto");
    assert.equal(client.backend, "pytorch");
    assert.equal(client.dtype, "float32");
    assert.equal(client.fallbackReason, "CUDA initialization failed; using CPU.");
    await client.stop();
    assert.equal(client.activeDevice, undefined);
    assert.equal(client.fallbackReason, undefined);
  } finally {
    await client.stop();
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    if (previousEnabled === undefined) delete process.env.VOICEPILOT_FILE_SEARCH_ENABLED;
    else process.env.VOICEPILOT_FILE_SEARCH_ENABLED = previousEnabled;
    if (previousPython === undefined) delete process.env.VOICEPILOT_FILE_SEARCH_PYTHON;
    else process.env.VOICEPILOT_FILE_SEARCH_PYTHON = previousPython;
  }
});

test("updates health-facing runtime when the worker falls back after startup", async () => {
  const previousEnabled = process.env.VOICEPILOT_FILE_SEARCH_ENABLED;
  const previousPython = process.env.VOICEPILOT_FILE_SEARCH_PYTHON;
  process.env.VOICEPILOT_FILE_SEARCH_ENABLED = "1";
  process.env.VOICEPILOT_FILE_SEARCH_PYTHON = "unused-python";
  let worker: ReadyWorker;
  const spawnMock = mock.method(childProcess, "spawn", (() => {
    worker = new ReadyWorker();
    queueMicrotask(() => worker.stdout.write(JSON.stringify({
      type: "ready", model: "google/embeddinggemma-2", device: "cuda",
      devicePreference: "auto", backend: "pytorch", dtype: "float32", fallbackReason: null,
    }) + "\n"));
    return worker as never;
  }) as never);
  syncBuiltinESMExports();
  const client = new FileSearchClient("unused-root");
  try {
    await client.start();
    assert.equal(client.activeDevice, "cuda");
    worker!.stdout.write(JSON.stringify({
      type: "runtime", model: "google/embeddinggemma-2", device: "cpu",
      devicePreference: "auto", backend: "pytorch", dtype: "float32",
      fallbackReason: "CUDA embedding failed; using CPU.",
    }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.activeDevice, "cpu");
    assert.equal(client.fallbackReason, "CUDA embedding failed; using CPU.");
  } finally {
    await client.stop();
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    if (previousEnabled === undefined) delete process.env.VOICEPILOT_FILE_SEARCH_ENABLED;
    else process.env.VOICEPILOT_FILE_SEARCH_ENABLED = previousEnabled;
    if (previousPython === undefined) delete process.env.VOICEPILOT_FILE_SEARCH_PYTHON;
    else process.env.VOICEPILOT_FILE_SEARCH_PYTHON = previousPython;
  }
});
