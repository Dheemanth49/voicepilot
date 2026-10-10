import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalRegistry } from "./approvals.js";

const request = {
  taskId: "task-1",
  actionId: "action-1",
  action: "launch_app",
  targetLabel: "Calculator",
  reason: "This application is not on the automatic launch allowlist.",
};

test("creates a pending approval with a bounded expiry", () => {
  const registry = new ApprovalRegistry({ timeoutMs: 60_000 });
  const created = registry.create(request);
  assert.equal(created.status, "pending");
  assert.equal(created.actionId, request.actionId);
  assert.equal(Date.parse(created.expiresAt) - Date.parse(created.createdAt), 60_000);
  assert.equal(registry.getPending().length, 1);
  registry.close();
});

test("approval decisions are one-use and wake the waiting action", async () => {
  const registry = new ApprovalRegistry();
  const created = registry.create(request);
  const waiting = registry.waitForDecision(created.approvalId);
  const resolved = registry.resolve(created.approvalId, "approve");
  assert.equal(resolved.ok, true);
  assert.equal(await waiting, "approved");
  assert.equal(registry.resolve(created.approvalId, "reject").ok, false);
  assert.equal(registry.get(created.approvalId)?.status, "approved");
  registry.close();
});

test("rejection resolves a waiting action without approving it", async () => {
  const registry = new ApprovalRegistry();
  const created = registry.create(request);
  const waiting = registry.waitForDecision(created.approvalId);
  assert.equal(registry.resolve(created.approvalId, "reject").ok, true);
  assert.equal(await waiting, "rejected");
  registry.close();
});

test("expired approvals cannot be approved or reused", async () => {
  const registry = new ApprovalRegistry({ timeoutMs: 5 });
  const created = registry.create(request);
  const waiting = registry.waitForDecision(created.approvalId);
  assert.equal(await waiting, "expired");
  const result = registry.resolve(created.approvalId, "approve");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "expired");
  assert.equal(registry.get(created.approvalId)?.status, "expired");
  registry.close();
});

test("task cancellation cancels its pending approvals", async () => {
  const registry = new ApprovalRegistry();
  const created = registry.create(request);
  const waiting = registry.waitForDecision(created.approvalId);
  assert.equal(registry.cancelForTask(request.taskId), 1);
  assert.equal(await waiting, "cancelled");
  assert.equal(registry.resolve(created.approvalId, "approve").ok, false);
  registry.close();
});

test("an approved action can be consumed exactly once", () => {
  const registry = new ApprovalRegistry();
  const created = registry.create(request);
  assert.equal(registry.resolve(created.approvalId, "approve").ok, true);
  assert.equal(registry.consumeApproved(created.approvalId), true);
  assert.equal(registry.consumeApproved(created.approvalId), false);
  assert.ok(registry.get(created.approvalId)?.consumedAt);
  registry.close();
});

test("task cancellation revokes an approved action before it is consumed", () => {
  const registry = new ApprovalRegistry();
  const created = registry.create(request);
  registry.resolve(created.approvalId, "approve");
  assert.equal(registry.cancelForTask(request.taskId), 1);
  assert.equal(registry.get(created.approvalId)?.status, "cancelled");
  assert.equal(registry.consumeApproved(created.approvalId), false);
  registry.close();
});

test("approved but unused actions still expire at the original deadline", async () => {
  const registry = new ApprovalRegistry({ timeoutMs: 5 });
  const created = registry.create(request);
  registry.resolve(created.approvalId, "approve");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(registry.get(created.approvalId)?.status, "expired");
  assert.equal(registry.consumeApproved(created.approvalId), false);
  registry.close();
});
