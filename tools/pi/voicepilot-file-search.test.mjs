import assert from "node:assert/strict";
import test from "node:test";
import { createFileSearchTools } from "./voicepilot-file-search.mjs";

function makeResponse(body, ok = true) {
  return { ok, async json() { return body; } };
}

test("Pi file search calls bridge with only the active tool ID", async () => {
  const calls = [];
  const tools = createFileSearchTools({
    environment: { VOICEPILOT_APPROVAL_TOKEN: "a".repeat(64), VOICEPILOT_APPROVAL_URL: "http://127.0.0.1:8787" },
    async fetcher(url, options) {
      calls.push({ url, body: JSON.parse(options.body), auth: options.headers.authorization });
      return makeResponse({ id: "call_1", ok: true, results: [{ resultId: "result_AABBCCDDEEFF00112233" }] });
    },
  });
  const result = await tools[0].execute("call_1", {});
  assert.equal(calls[0].url, "http://127.0.0.1:8787/api/internal/file-search/search");
  assert.deepEqual(calls[0].body, { actionId: "call_1" });
  assert.equal(calls[0].auth, `Bearer ${"a".repeat(64)}`);
  assert.equal(result.details.resultCount, 1);
});

test("Pi may open only by passing a result ID to the bridge", async () => {
  const calls = [];
  const tools = createFileSearchTools({
    environment: { VOICEPILOT_APPROVAL_TOKEN: "b".repeat(64) },
    async fetcher(url, options) {
      calls.push({ url, body: JSON.parse(options.body) });
      return makeResponse({ id: "call_2", ok: true, opened: true });
    },
  });
  const result = await tools[1].execute("call_2", { resultId: "result_AABBCCDDEEFF00112233" });
  assert.deepEqual(calls[0].body, { actionId: "call_2", resultId: "result_AABBCCDDEEFF00112233" });
  assert.match(result.content[0].text, /opened/);
});

test("Pi file search reports bridge rejection as an error result", async () => {
  const tools = createFileSearchTools({
    environment: { VOICEPILOT_APPROVAL_TOKEN: "c".repeat(64) },
    async fetcher() { return makeResponse({ error: { message: "No active file search task." } }, false); },
  });
  const result = await tools[0].execute("call_3", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No active file search task/);
});
