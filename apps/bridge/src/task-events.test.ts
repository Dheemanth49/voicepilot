import assert from "node:assert/strict";
import test from "node:test";
import { createTaskEvent, createWebSocketHandshake, encodeWebSocketFrame, websocketAccept } from "./task-events.js";

test("computes the RFC 6455 websocket handshake accept value", () => {
  assert.equal(websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("accepts only the configured UI origin on the task socket path", () => {
  const input = {
    path: "/ws",
    origin: "http://127.0.0.1:5173",
    expectedOrigin: "http://127.0.0.1:5173",
    upgrade: "websocket",
    connection: "keep-alive, Upgrade",
    key: "dGhlIHNhbXBsZSBub25jZQ==",
  };
  assert.match(createWebSocketHandshake(input) ?? "", /^HTTP\/1\.1 101/);
  assert.equal(createWebSocketHandshake({ ...input, origin: "https://attacker.invalid" }), undefined);
  assert.equal(createWebSocketHandshake({ ...input, path: "/other" }), undefined);
  assert.equal(createWebSocketHandshake({ ...input, key: "invalid" }), undefined);
});

test("encodes unmasked server text frames at short and extended lengths", () => {
  assert.deepEqual([...encodeWebSocketFrame("ok")], [0x81, 2, 0x6f, 0x6b]);
  const extended = encodeWebSocketFrame("x".repeat(126));
  assert.deepEqual([...extended.subarray(0, 4)], [0x81, 126, 0, 126]);
  assert.equal(extended.length, 130);
});

test("creates task events with the shared event envelope", () => {
  const event = createTaskEvent("task.status", "task-1", { status: "executing" });
  assert.match(event.eventId, /^[0-9a-f-]{36}$/i);
  assert.equal(event.type, "task.status");
  assert.equal(event.taskId, "task-1");
  assert.equal(typeof event.timestamp, "string");
  assert.deepEqual(event.data, { status: "executing" });
});
