import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transcribeAudioUpload } from "./audio-transcription.js";

async function* chunks(...parts: (Buffer | string)[]) {
  for (const part of parts) yield part;
}

test("rejects unsupported audio formats before reading the upload", async () => {
  let read = false;
  async function* body() { read = true; yield Buffer.from("x"); }
  const result = await transcribeAudioUpload({ contentType: "application/octet-stream", body: body(), enabled: true, dataDirectory: tmpdir(), transcribe: async () => "" });
  assert.equal(result.status, 415);
  assert.equal(read, false);
});

test("writes accepted audio temporarily and removes it after successful transcription", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voicepilot-audio-"));
  let transcribedPath = "";
  try {
    const result = await transcribeAudioUpload({
      contentType: "audio/webm;codecs=opus", body: chunks(Buffer.from("audio-"), "bytes"), enabled: true, dataDirectory: directory,
      transcribe: async (path) => { transcribedPath = path; assert.equal(readFileSync(path, "utf8"), "audio-bytes"); return "Open Notepad."; },
    });
    assert.deepEqual(result, { status: 200, body: { text: "Open Notepad." } });
    assert.equal(transcribedPath.endsWith(".webm"), true);
    assert.equal(readdirSync(directory).length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("removes the temporary recording when transcription fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voicepilot-audio-"));
  try {
    const result = await transcribeAudioUpload({ contentType: "audio/wav", body: chunks("wav bytes"), enabled: true, dataDirectory: directory, transcribe: async () => { throw new Error("model unavailable"); } });
    assert.deepEqual(result, { status: 503, body: { error: { code: "STT_UNAVAILABLE", message: "model unavailable" } } });
    assert.equal(readdirSync(directory).length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects empty and over-limit recordings without invoking STT", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voicepilot-audio-"));
  let calls = 0;
  try {
    const transcribe = async () => { calls += 1; return "unexpected"; };
    const empty = await transcribeAudioUpload({ contentType: "audio/mp4", body: chunks(), enabled: true, dataDirectory: directory, transcribe });
    const oversized = await transcribeAudioUpload({ contentType: "audio/ogg", body: chunks(Buffer.alloc(25 * 1024 * 1024), Buffer.from([1])), enabled: true, dataDirectory: directory, transcribe });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error?.message ?? "", /empty/i);
    assert.equal(oversized.status, 400);
    assert.match(oversized.body.error?.message ?? "", /25 MB/i);
    assert.equal(calls, 0);
    assert.equal(readdirSync(directory).length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("returns a clear disabled response without consuming audio", async () => {
  let read = false;
  async function* body() { read = true; yield Buffer.from("audio"); }
  const result = await transcribeAudioUpload({ contentType: "audio/mpeg", body: body(), enabled: false, disabledReason: "Speech disabled.", dataDirectory: tmpdir(), transcribe: async () => "" });
  assert.equal(result.status, 503);
  assert.equal(result.body.error?.message, "Speech disabled.");
  assert.equal(read, false);
});
