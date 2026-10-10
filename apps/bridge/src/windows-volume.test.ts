import assert from "node:assert/strict";
import test from "node:test";
import { setWindowsSystemVolume } from "./windows-volume.js";

test("sets the requested Windows master volume and returns the verified read-back", async () => {
  const calls: Array<{ scriptPath: string; level: number }> = [];
  const result = await setWindowsSystemVolume(5, {
    platform: "win32",
    projectRoot: "C:\\voicepilot",
    runScript: async (scriptPath, level) => {
      calls.push({ scriptPath, level });
      return JSON.stringify({ level: 5 });
    },
  });
  assert.equal(result, 5);
  assert.deepEqual(calls, [{ scriptPath: "C:\\voicepilot\\scripts\\set-windows-volume.ps1", level: 5 }]);
});

test("rejects invalid levels before invoking Windows", async () => {
  let invoked = false;
  await assert.rejects(() => setWindowsSystemVolume(101, {
    platform: "win32",
    runScript: async () => { invoked = true; return "{}"; },
  }), /between 0 and 100/);
  assert.equal(invoked, false);
});

test("rejects an inaccurate read-back instead of reporting false success", async () => {
  await assert.rejects(() => setWindowsSystemVolume(5, {
    platform: "win32",
    runScript: async () => JSON.stringify({ level: 27 }),
  }), /could not verify/);
});

test("does not attempt to change volume on a non-Windows host", async () => {
  let invoked = false;
  await assert.rejects(() => setWindowsSystemVolume(5, {
    platform: "linux",
    runScript: async () => { invoked = true; return JSON.stringify({ level: 5 }); },
  }), /Windows only/);
  assert.equal(invoked, false);
});
