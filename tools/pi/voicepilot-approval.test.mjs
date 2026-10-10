import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalGate, createVolumeTool, extractLaunchAppTarget } from "./voicepilot-approval.mjs";

function response(value, ok = true, status = ok ? 200 : 409) {
  return { ok, status, json: async () => value };
}

function gateHarness(fetcher, wait = async () => {}) {
  const gate = createApprovalGate({
    fetcher,
    wait,
    now: () => 1_000,
    environment: { VOICEPILOT_APPROVAL_TOKEN: "a".repeat(64), VOICEPILOT_APPROVAL_URL: "http://127.0.0.1:8787" },
  });
  return (toolName, input = { name: "Calculator" }) => gate({ toolName, toolCallId: "call-1", input }, { signal: undefined });
}

test("extracts one unambiguous app target and rejects paths or extra launch parameters", () => {
  assert.equal(extractLaunchAppTarget({ name: "Calculator" }), "Calculator");
  assert.equal(extractLaunchAppTarget({ app_id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" }), "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");
  assert.equal(extractLaunchAppTarget({ aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" }), "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");
  assert.equal(extractLaunchAppTarget({ name: "Calculator", app_id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" }), "Calculator");
  assert.equal(extractLaunchAppTarget({ name: "C:\\Windows\\System32\\calc.exe" }), undefined);
  assert.equal(extractLaunchAppTarget({ path: "C:\\Windows\\System32\\calc.exe" }), undefined);
  assert.equal(extractLaunchAppTarget({ name: "Calculator", urls: ["https://example.com"] }), undefined);
  assert.equal(extractLaunchAppTarget({ name: "Calculator", additional_arguments: ["--unsafe"] }), undefined);
  assert.equal(extractLaunchAppTarget({ name: "Calculator", app_id: "notepad" }), undefined);
});

test("lets the bridge authorize the user's direct Notepad request", async () => {
  const requests = [];
  const run = gateHarness(async (url, options) => {
    requests.push({ url, options });
    return response({ status: "authorized" });
  });
  assert.equal(await run("computer_use_launch_app", { name: "Notepad" }), undefined);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /api\/internal\/actions\/authorize$/);
});

test("pauses an app launch until approval, then consumes that approval once", async () => {
  const calls = [];
  const run = gateHarness(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/internal/actions/authorize")) {
      return response({ status: "pending", approval: { approvalId: "approval-1", expiresAt: new Date(60_000).toISOString() } }, true, 202);
    }
    if (url.endsWith("/api/internal/approvals/approval-1")) return response({ approval: { status: "approved" } });
    if (url.endsWith("/consume")) return response({ consumed: true });
    return response({}, false);
  });
  assert.equal(await run("computer_use_launch_app", { name: "Calculator" }), undefined);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.method, "POST");
});

test("blocks a rejected app launch and every unsupported mutating computer-use tool", async () => {
  let requestCount = 0;
  const run = gateHarness(async (url) => {
    requestCount += 1;
    if (url.endsWith("/api/internal/actions/authorize")) {
      return response({ status: "pending", approval: { approvalId: "approval-2", expiresAt: new Date(60_000).toISOString() } }, true, 202);
    }
    return response({ approval: { status: "rejected" } });
  });
  const rejected = await run("computer_use_launch_app", { name: "Calculator" });
  assert.equal(rejected.block, true);
  assert.equal(rejected.terminate, true);
  const unsupported = await run("computer_use_click", { x: 2, y: 3 });
  assert.equal(unsupported.block, true);
  assert.equal(requestCount, 2);
});

test("authorizes only a bounded scroll matching the VoicePilot tool input", async () => {
  const calls = [];
  const run = gateHarness(async (url, options) => {
    calls.push({ url, options });
    return response({ status: "authorized" });
  });
  assert.equal(await run("computer_use_scroll", { pid: 1234, direction: "down", by: "page", amount: 2 }), undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    actionId: "call-1", action: "scroll", direction: "down", by: "page", amount: 2,
  });
  const blocked = await run("computer_use_scroll", { pid: 1234, direction: "down", by: "page", amount: 50 });
  assert.equal(blocked.block, true);
});

test("exposes a bounded volume tool that delegates the requested value to the authenticated bridge", async () => {
  const calls = [];
  const tool = createVolumeTool({
    environment: { VOICEPILOT_APPROVAL_TOKEN: "a".repeat(64), VOICEPILOT_APPROVAL_URL: "http://127.0.0.1:8787" },
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return response({ level: 5, verified: true });
    },
  });
  const result = await tool.execute("volume-call-1", { level: 5 });
  assert.equal(tool.name, "voicepilot_set_volume");
  assert.equal(tool.parameters.properties.level.minimum, 0);
  assert.equal(tool.parameters.properties.level.maximum, 100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8787/api/internal/volume/set");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${"a".repeat(64)}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { actionId: "volume-call-1", level: 5 });
  assert.match(result.content[0].text, /5%/);
});

test("does not send invalid levels to the bridge", async () => {
  let calls = 0;
  const tool = createVolumeTool({
    environment: { VOICEPILOT_APPROVAL_TOKEN: "a".repeat(64), VOICEPILOT_APPROVAL_URL: "http://127.0.0.1:8787" },
    fetcher: async () => { calls += 1; return response({ level: 5, verified: true }); },
  });
  const result = await tool.execute("volume-call-2", { level: 101 });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});
