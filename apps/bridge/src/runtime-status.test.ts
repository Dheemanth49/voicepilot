import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRuntimeStatus } from "./runtime-status.js";

test("runtime health omits devices until workers report readiness", () => {
  assert.deepEqual(buildRuntimeStatus({}), {});
  assert.deepEqual(buildRuntimeStatus({ stt: null, fileSearch: null }), {});
});

test("runtime health includes only actual reported service devices", () => {
  assert.deepEqual(buildRuntimeStatus({
    stt: { device: "cpu", devicePreference: "auto", backend: "ctranslate2", fallbackReason: "CUDA runtime unavailable; using CPU." },
    fileSearch: { device: "cuda", devicePreference: "auto", backend: "pytorch", dtype: "float32", fallbackReason: null },
  }), {
    sttRuntime: { device: "cpu", devicePreference: "auto", backend: "ctranslate2", fallbackReason: "CUDA runtime unavailable; using CPU." },
    fileSearchRuntime: { device: "cuda", devicePreference: "auto", backend: "pytorch", dtype: "float32", fallbackReason: null },
  });
});
