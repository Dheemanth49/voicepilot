import type { TaskResponse } from "../../../packages/contracts/src/index.js";

const TASK_STATUSES = new Set(["executing", "succeeded", "partially_succeeded", "failed", "cancelled"]);

export function normalizeTaskHistory(saved: unknown, recoveredAt = new Date().toISOString()): TaskResponse[] {
  if (!Array.isArray(saved)) return [];
  return saved.filter(isTaskResponse).slice(0, 50).map((task) => {
    const recovered = task.status === "executing";
    const actionSteps = Array.isArray(task.actionSteps)
      ? task.actionSteps.filter(isTaskActionStep).map((step) => recovered && step.status === "running"
        ? { ...step, status: "failed" as const, completedAt: recoveredAt }
        : step)
      : undefined;
    return {
      ...task,
      ...(actionSteps ? { actionSteps } : { actionSteps: undefined }),
      ...(recovered ? { status: "failed" as const, error: "VoicePilot restarted before this task completed.", completedAt: recoveredAt } : {}),
    };
  });
}

function isTaskResponse(entry: unknown): entry is TaskResponse {
  if (!entry || typeof entry !== "object") return false;
  const task = entry as Partial<TaskResponse>;
  return typeof task.taskId === "string"
    && typeof task.transcript === "string"
    && typeof task.createdAt === "string"
    && typeof task.status === "string"
    && TASK_STATUSES.has(task.status)
    && (task.completedAt === undefined || typeof task.completedAt === "string")
    && (task.result === undefined || typeof task.result === "string")
    && (task.error === undefined || typeof task.error === "string")
    && (task.actionSteps === undefined || Array.isArray(task.actionSteps));
}

function isTaskActionStep(step: unknown): step is NonNullable<TaskResponse["actionSteps"]>[number] {
  if (!step || typeof step !== "object") return false;
  const action = step as Partial<NonNullable<TaskResponse["actionSteps"]>[number]>;
  return typeof action.id === "string"
    && typeof action.label === "string"
    && typeof action.startedAt === "string"
    && typeof action.status === "string"
    && ["running", "completed", "failed"].includes(action.status)
    && (action.completedAt === undefined || typeof action.completedAt === "string");
}
