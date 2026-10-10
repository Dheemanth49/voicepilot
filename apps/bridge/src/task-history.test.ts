import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskHistory } from "./task-history.js";

test("recovers in-flight tasks as failed with a restart explanation", () => {
  const [task] = normalizeTaskHistory([{
    taskId: "task-1",
    status: "executing",
    transcript: "Open Notepad",
    createdAt: "2026-10-10T00:00:00.000Z",
  }], "2026-10-10T01:00:00.000Z");
  assert.equal(task.status, "failed");
  assert.equal(task.error, "VoicePilot restarted before this task completed.");
  assert.equal(task.completedAt, "2026-10-10T01:00:00.000Z");
});

test("retains terminal tasks, drops malformed entries, and caps history", () => {
  const valid = Array.from({ length: 55 }, (_, index) => ({
    taskId: `task-${index}`,
    status: "succeeded",
    transcript: "Open Notepad",
    createdAt: "2026-10-10T00:00:00.000Z",
  }));
  const tasks = normalizeTaskHistory([null, { taskId: "bad" }, ...valid]);
  assert.equal(tasks.length, 50);
  assert.equal(tasks[0].taskId, "task-0");
  assert.equal(tasks[0].status, "succeeded");
});

test("preserves cancelled terminal tasks", () => {
  const [task] = normalizeTaskHistory([{
    taskId: "task-cancelled",
    status: "cancelled",
    transcript: "Open Notepad",
    createdAt: "2026-10-10T00:00:00.000Z",
  }]);
  assert.equal(task.status, "cancelled");
});
