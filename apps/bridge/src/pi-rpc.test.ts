import assert from "node:assert/strict";
import test from "node:test";
import { getDesktopToolsStatus, getSuccessfulCloseApp, getSuccessfulScroll, getSuccessfulVolumeSetCallId, hasSuccessfulAppLaunch, hasSuccessfulNotepadLaunch, hasSuccessfulVolumeSet, wasCancelledBeforeAction, type PiRpcEvent } from "./pi-rpc.js";

function call(toolName: string, args: unknown, isError = false): PiRpcEvent[] {
  return [
    { type: "tool_execution_start", toolCallId: "call-1", toolName, args },
    { type: "tool_execution_end", toolCallId: "call-1", toolName, isError },
  ];
}

test("requires a successful launch_app tool call for Notepad", () => {
  assert.equal(hasSuccessfulNotepadLaunch(call("computer_use_launch_app", { name: "notepad.exe" })), true);
  assert.equal(hasSuccessfulNotepadLaunch(call("computer_use_launch_app", { name: "Notepad" })), true);
});

test("matches a successful app launch against the target the user requested", () => {
  assert.equal(hasSuccessfulAppLaunch(call("computer_use_launch_app", { name: "Calculator" }), "Calculator"), true);
  assert.equal(hasSuccessfulAppLaunch(call("computer_use_launch_app", { app_id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" }), "Calculator"), true);
  assert.equal(hasSuccessfulAppLaunch(call("computer_use_launch_app", { name: "Notepad" }), "Calculator"), false);
  assert.equal(hasSuccessfulAppLaunch(call("computer_use_launch_app", { name: "Calculator" }, true), "Calculator"), false);
});

test("does not treat other successful computer-use calls as proof Notepad opened", () => {
  assert.equal(hasSuccessfulNotepadLaunch(call("computer_use_connect", {})), false);
  assert.equal(hasSuccessfulNotepadLaunch(call("computer_use_list_windows", {})), false);
  assert.equal(hasSuccessfulNotepadLaunch(call("computer_use_launch_app", { name: "Calculator" })), false);
  assert.equal(hasSuccessfulNotepadLaunch(call("computer_use_launch_app", { name: "notepad.exe" }, true)), false);
});

test("matches tool start and end events by call ID", () => {
  const events: PiRpcEvent[] = [
    { type: "tool_execution_start", toolCallId: "call-a", toolName: "computer_use_launch_app", args: { name: "notepad.exe" } },
    { type: "tool_execution_end", toolCallId: "call-b", isError: false },
  ];
  assert.equal(hasSuccessfulNotepadLaunch(events), false);
});

test("reports cancellation only when Pi aborts before a successful Notepad launch", () => {
  assert.equal(wasCancelledBeforeAction([{ type: "agent_settled", aborted: true }]), true);
  assert.equal(wasCancelledBeforeAction([
    ...call("computer_use_launch_app", { name: "notepad.exe" }),
    { type: "agent_settled", aborted: true },
  ]), false);
  assert.equal(wasCancelledBeforeAction([{ type: "agent_settled", aborted: false }]), false);
  const volume = [
    { type: "tool_execution_start", toolCallId: "volume-1", toolName: "voicepilot_set_volume", args: { level: 5 } },
    { type: "tool_execution_end", toolCallId: "volume-1", toolName: "voicepilot_set_volume", isError: false },
    { type: "agent_settled", aborted: true },
  ] satisfies PiRpcEvent[];
  assert.equal(wasCancelledBeforeAction(volume, undefined, 5), false);
  assert.equal(wasCancelledBeforeAction([{ type: "agent_settled", aborted: true }], undefined, 5), true);
});

test("verifies the volume tool ran successfully with the exact requested percentage", () => {
  const events: PiRpcEvent[] = [
    { type: "tool_execution_start", toolCallId: "volume-1", toolName: "voicepilot_set_volume", args: { level: 5 } },
    { type: "tool_execution_end", toolCallId: "volume-1", toolName: "voicepilot_set_volume", isError: false },
  ];
  assert.equal(hasSuccessfulVolumeSet(events, 5), true);
  assert.equal(getSuccessfulVolumeSetCallId(events, 5), "volume-1");
  assert.equal(hasSuccessfulVolumeSet(events, 4), false);
  assert.equal(hasSuccessfulVolumeSet([{ ...events[0] }, { ...events[1], isError: true }], 5), false);
});

test("verifies scroll success only for the exact bounded tool arguments", () => {
  const events = call("computer_use_scroll", { pid: 1234, direction: "down", by: "page", amount: 2 });
  assert.equal(getSuccessfulScroll(events, { direction: "down", by: "page", amount: 2 }), "call-1");
  assert.equal(getSuccessfulScroll(events, { direction: "up", by: "page", amount: 2 }), undefined);
  assert.equal(getSuccessfulScroll(call("computer_use_scroll", { pid: 1234, direction: "down", by: "page", amount: 2 }, true), { direction: "down", by: "page", amount: 2 }), undefined);
});

test("verifies the close-app tool succeeded for the exact app and call ID", () => {
  assert.equal(getSuccessfulCloseApp(call("voicepilot_close_app", { app_name: "Notepad" }), "Notepad"), "call-1");
  assert.equal(getSuccessfulCloseApp(call("voicepilot_close_app", { app_name: "Calculator" }), "Notepad"), undefined);
  assert.equal(getSuccessfulCloseApp(call("voicepilot_close_app", { app_name: "Notepad" }, true), "Notepad"), undefined);
});

test("reports desktop tools unavailable until the extension is present and RPC is ready", () => {
  assert.equal(getDesktopToolsStatus(false, false, []), "unavailable");
  assert.equal(getDesktopToolsStatus(true, false, []), "unavailable");
  assert.equal(getDesktopToolsStatus(false, true, []), "initializing");
});

test("reports CUA discovery recovery mode as misconfigured and live discovery as available", () => {
  assert.equal(getDesktopToolsStatus(true, true, [
    { name: "computer-use-tools" },
    { name: "computer-use-connect" },
  ]), "available");
  assert.equal(getDesktopToolsStatus(true, true, [
    { name: "computer-use-tools" },
  ]), "available");
  assert.equal(getDesktopToolsStatus(true, true, []), "misconfigured");
});
