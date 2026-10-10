import assert from "node:assert/strict";
import test from "node:test";
import { createComputerUseExtension } from "./voicepilot-computer-use.mjs";

function createPiHarness() {
  const events = new Map();
  const tools = new Map();
  const commands = new Map();
  return {
    pi: {
      on: (name, callback) => events.set(name, callback),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: (name, command) => commands.set(name, command),
    },
    events,
    tools,
    commands,
  };
}

const liveTools = [
  { name: "launch_app", description: "Launch an app", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "list_apps", description: "List apps", inputSchema: { type: "object", properties: {} } },
  { name: "list_windows", description: "List windows", inputSchema: { type: "object", properties: {} } },
  { name: "kill_app", description: "Stop an app", inputSchema: { type: "object", properties: { pid: { type: "integer" } } } },
];

test("discovers core CUA tools over direct MCP and forwards the real tool result", async () => {
  const calls = [];
  const fakeClient = {
    async connect() {},
    async listTools() { return { tools: liveTools }; },
    async callTool(name, args, signal) {
      calls.push({ name, args, signal });
      return { content: [{ type: "text", text: "Notepad launched" }], structuredContent: { pid: 4321 } };
    },
    async close() {},
  };
  const harness = createPiHarness();
  createComputerUseExtension({ createClient: () => fakeClient })(harness.pi);

  await harness.events.get("session_start")({}, { signal: new AbortController().signal });

  assert.deepEqual([...harness.tools.keys()], ["voicepilot_close_app", "computer_use_launch_app", "computer_use_list_apps", "computer_use_list_windows"]);
  assert.equal(harness.commands.has("voicepilot-close-app"), true);
  assert.equal(harness.commands.has("computer-use-tools"), true);
  const signal = new AbortController().signal;
  const result = await harness.tools.get("computer_use_launch_app").execute("call-1", { name: "Notepad" }, signal);
  assert.equal(calls[0].name, "launch_app");
  assert.deepEqual(calls[0].args, { name: "Notepad" });
  assert.equal(calls[0].signal, signal);
  assert.deepEqual(result.content, [{ type: "text", text: "Notepad launched" }]);
  assert.deepEqual(result.details, { pid: 4321 });
});

test("reports CUA unavailable and offers a recovery command after direct startup fails", async () => {
  const harness = createPiHarness();
  createComputerUseExtension({
    createClient: () => ({
      async connect() { throw new Error("driver unavailable"); },
      async listTools() { throw new Error("must not enumerate a disconnected driver"); },
      async callTool() { throw new Error("must not call a disconnected driver"); },
      async close() {},
    }),
  })(harness.pi);

  await harness.events.get("session_start")({}, { signal: new AbortController().signal });

  assert.equal(harness.tools.has("computer_use_connect"), true);
  assert.equal(harness.commands.has("computer-use-connect"), true);
  assert.equal(harness.commands.has("computer-use-tools"), false);
});

test("replaces a failed direct MCP client when the recovery tool reconnects", async () => {
  let clientsCreated = 0;
  const harness = createPiHarness();
  createComputerUseExtension({
    createClient: () => {
      const attempt = ++clientsCreated;
      return {
        async connect() { if (attempt === 1) throw new Error("startup pipe failure"); },
        async listTools() { return { tools: liveTools }; },
        async callTool() { return { content: [{ type: "text", text: "ok" }] }; },
        async close() {},
      };
    },
  })(harness.pi);

  await harness.events.get("session_start")({}, { signal: new AbortController().signal });
  const recovered = await harness.tools.get("computer_use_connect").execute("retry-1", {}, new AbortController().signal);

  assert.equal(clientsCreated, 2);
  assert.match(recovered.content[0].text, /registered 3 core tools/);
  assert.equal(harness.tools.has("computer_use_launch_app"), true);
  assert.equal(harness.commands.has("computer-use-tools"), true);
});

test("closes the direct CUA client when the Pi session shuts down", async () => {
  let closed = 0;
  const harness = createPiHarness();
  createComputerUseExtension({
    createClient: () => ({
      async connect() {},
      async listTools() { return { tools: liveTools }; },
      async callTool() { return { content: [] }; },
      async close() { closed += 1; },
    }),
  })(harness.pi);

  await harness.events.get("session_start")({}, { signal: new AbortController().signal });
  await harness.events.get("session_shutdown")();

  assert.equal(closed, 1);
});
