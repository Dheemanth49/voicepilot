import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRecord, ApprovalStatus } from "../../../packages/contracts/src/index.js";

export interface NewApproval {
  taskId: string;
  actionId: string;
  action: string;
  targetLabel: string;
  reason: string;
}

export type ApprovalResolution =
  | { ok: true; approval: ApprovalRecord }
  | { ok: false; reason: "not_found" | "not_pending" | "expired" };

export class ApprovalRegistry {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly waiters = new Map<string, Set<(status: ApprovalStatus) => void>>();
  private readonly listeners = new Set<(approval: ApprovalRecord, previousStatus?: ApprovalStatus) => void>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: { timeoutMs?: number; now?: () => number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError("Approval timeout must be a positive integer number of milliseconds.");
    }
  }

  create(input: NewApproval): ApprovalRecord {
    const createdAt = this.now();
    const approval: ApprovalRecord = {
      approvalId: randomUUID(),
      ...input,
      status: "pending",
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.timeoutMs).toISOString(),
    };
    this.records.set(approval.approvalId, approval);
    const timer = setTimeout(() => this.transition(approval.approvalId, "expired"), this.timeoutMs);
    timer.unref?.();
    this.timers.set(approval.approvalId, timer);
    this.notify(approval);
    return copy(approval);
  }

  subscribe(listener: (approval: ApprovalRecord, previousStatus?: ApprovalStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(approvalId: string): ApprovalRecord | undefined {
    const approval = this.records.get(approvalId);
    if (!approval) return undefined;
    if ((approval.status === "pending" || (approval.status === "approved" && !approval.consumedAt))
      && this.now() >= Date.parse(approval.expiresAt)) {
      this.transition(approvalId, "expired");
    }
    const current = this.records.get(approvalId);
    return current ? copy(current) : undefined;
  }

  getPending(taskId?: string): ApprovalRecord[] {
    const pending = [...this.records.values()]
      .filter((approval) => approval.status === "pending" && (!taskId || approval.taskId === taskId));
    return pending.map((approval) => this.get(approval.approvalId)).filter((approval): approval is ApprovalRecord => approval?.status === "pending");
  }

  findByTaskAction(taskId: string, actionId: string): ApprovalRecord | undefined {
    const approval = [...this.records.values()].find((item) => item.taskId === taskId && item.actionId === actionId);
    return approval ? this.get(approval.approvalId) : undefined;
  }

  hasPendingForTask(taskId: string): boolean {
    return this.getPending(taskId).length > 0;
  }

  hasOutstandingForTask(taskId: string): boolean {
    return [...this.records.values()].some((approval) => approval.taskId === taskId
      && (approval.status === "pending" || (approval.status === "approved" && !approval.consumedAt))
      && this.now() < Date.parse(approval.expiresAt));
  }

  resolve(approvalId: string, decision: ApprovalDecision): ApprovalResolution {
    const approval = this.get(approvalId);
    if (!approval) return { ok: false, reason: "not_found" };
    if (approval.status === "expired") return { ok: false, reason: "expired" };
    if (approval.status !== "pending") return { ok: false, reason: "not_pending" };
    const updated = this.transition(approvalId, decision === "approve" ? "approved" : "rejected");
    return updated ? { ok: true, approval: updated } : { ok: false, reason: "not_pending" };
  }

  waitForDecision(approvalId: string): Promise<ApprovalStatus> {
    const approval = this.get(approvalId);
    if (!approval) return Promise.reject(new Error("Approval does not exist."));
    if (approval.status !== "pending") return Promise.resolve(approval.status);
    return new Promise((resolve) => {
      const listeners = this.waiters.get(approvalId) ?? new Set<(status: ApprovalStatus) => void>();
      listeners.add(resolve);
      this.waiters.set(approvalId, listeners);
    });
  }

  cancelForTask(taskId: string): number {
    const approvals = [...this.records.values()].filter((approval) => approval.taskId === taskId
      && (approval.status === "pending" || (approval.status === "approved" && !approval.consumedAt)));
    for (const approval of approvals) this.transition(approval.approvalId, "cancelled");
    return approvals.length;
  }

  consumeApproved(approvalId: string): boolean {
    const approval = this.get(approvalId);
    if (!approval || approval.status !== "approved" || approval.consumedAt) return false;
    const current = this.records.get(approvalId);
    if (!current || current.status !== "approved" || current.consumedAt) return false;
    this.records.set(approvalId, { ...current, consumedAt: new Date(this.now()).toISOString() });
    return true;
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const listeners of this.waiters.values()) {
      for (const resolve of listeners) resolve("cancelled");
    }
    this.waiters.clear();
  }

  private transition(approvalId: string, status: Exclude<ApprovalStatus, "pending">): ApprovalRecord | undefined {
    const approval = this.records.get(approvalId);
    const canResolve = approval?.status === "pending"
      || (approval?.status === "approved" && !approval.consumedAt && (status === "expired" || status === "cancelled"));
    if (!approval || !canResolve) return undefined;
    const updated: ApprovalRecord = { ...approval, status, resolvedAt: new Date(this.now()).toISOString() };
    this.records.set(approvalId, updated);
    const timer = this.timers.get(approvalId);
    if (timer) clearTimeout(timer);
    this.timers.delete(approvalId);
    const listeners = this.waiters.get(approvalId);
    this.waiters.delete(approvalId);
    for (const resolve of listeners ?? []) resolve(status);
    this.notify(updated, approval.status);
    return copy(updated);
  }

  private notify(approval: ApprovalRecord, previousStatus?: ApprovalStatus): void {
    for (const listener of this.listeners) listener(copy(approval), previousStatus);
  }
}

function copy(approval: ApprovalRecord): ApprovalRecord {
  return { ...approval };
}
