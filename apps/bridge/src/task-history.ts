import type { TaskResponse } from "../../../packages/contracts/src/index.js";

const TASK_STATUSES = new Set(["executing", "succeeded", "failed", "cancelled"]);

export function normalizeTaskHistory(saved: unknown, recoveredAt = new Date().toISOString()): TaskResponse[] {
  if (!Array.isArray(saved)) return [];
  return saved.filter(isTaskResponse).slice(0, 50).map((task) => task.status === "executing"
    ? { ...task, status: "failed", error: "VoicePilot restarted before this task completed.", completedAt: recoveredAt }
    : task);
}

function isTaskResponse(entry: unknown): entry is TaskResponse {
  if (!entry || typeof entry !== "object") return false;
  const task = entry as Partial<TaskResponse>;
  return typeof task.taskId === "string"
    && typeof task.transcript === "string"
    && typeof task.createdAt === "string"
    && typeof task.status === "string"
    && TASK_STATUSES.has(task.status);
}
