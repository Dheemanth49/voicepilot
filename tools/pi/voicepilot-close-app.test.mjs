import assert from "node:assert/strict";
import test from "node:test";
import { createCloseAppTool, selectWindow } from "./voicepilot-close-app.mjs";

const environment = { VOICEPILOT_APPROVAL_TOKEN: "a".repeat(64), VOICEPILOT_APPROVAL_URL: "http://127.0.0.1:8787" };

test("matches Windows windows whose app_name is empty using an exact title suffix", () => {
  assert.equal(selectWindow([
    { app_name: "", title: "Untitled - Notepad", pid: 123, window_id: 11, is_on_screen: true, z_index: 4 },
    { app_name: "", title: "A Notepad tutorial - Brave", pid: 456, window_id: 12, is_on_screen: true, z_index: 5 },
  ], "Notepad").window_id, 11);
});

test("closes the frontmost matching app window and verifies that exact window disappeared", async () => {
  const calls = [];
  let listing = 0;
  const tool = createCloseAppTool({
    environment,
    authorize: async (input) => { calls.push({ name: "authorize", input }); return { ok: true }; },
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "list_windows") {
        listing += 1;
        return { structuredContent: { windows: listing === 1
          ? [
            { app_name: "Notepad", pid: 123, window_id: 9, is_on_screen: true, z_index: 3 },
            { app_name: "Calculator", pid: 456, window_id: 10, is_on_screen: true, z_index: 5 },
            { app_name: "Notepad", pid: 123, window_id: 11, is_on_screen: true, z_index: 8 },
          ]
          : [{ app_name: "Notepad", pid: 123, window_id: 9, is_on_screen: true, z_index: 3 }] } };
      }
      return { isError: false, content: [{ type: "text", text: "Hotkey sent" }] };
    },
    wait: async () => {},
  });

  const result = await tool.execute("close-call-1", { app_name: "Notepad" });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /window closed and was verified/i);
  assert.deepEqual(calls[1], { name: "authorize", input: {
    actionId: "close-call-1", action: "close_app", targetLabel: "Notepad", pid: 123, windowId: 11,
  } });
  assert.deepEqual(calls[2], { name: "hotkey", args: {
    pid: 123, window_id: 11, keys: ["alt", "f4"], delivery_mode: "background",
  } });
});

test("does not report success when the requested window remains open", async () => {
  const tool = createCloseAppTool({
    environment,
    authorize: async () => ({ ok: true }),
    callTool: async (name) => name === "list_windows"
      ? { structuredContent: { windows: [{ app_name: "Notepad", pid: 123, window_id: 11, is_on_screen: true, z_index: 1 }] } }
      : { isError: false },
    wait: async () => {},
  });
  const result = await tool.execute("close-call-2", { app_name: "Notepad" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /remains open/i);
});
