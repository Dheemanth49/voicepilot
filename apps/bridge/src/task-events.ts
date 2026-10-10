import { createHash, randomUUID } from "node:crypto";
import type { TaskEvent, TaskEventType } from "../../../packages/contracts/src/index.js";

export type { TaskEvent, TaskEventType };

export function createTaskEvent(type: TaskEventType, taskId: string, data: Record<string, unknown>): TaskEvent {
  return { eventId: randomUUID(), type, taskId, timestamp: new Date().toISOString(), data };
}

export function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

export function createWebSocketHandshake(input: {
  path: string;
  origin?: string;
  expectedOrigin: string;
  upgrade?: string;
  connection?: string;
  key?: string;
}): string | undefined {
  const key = input.key;
  const decodedKey = typeof key === "string" ? Buffer.from(key, "base64") : undefined;
  const validKey = decodedKey?.length === 16 && decodedKey.toString("base64") === key;
  const hasUpgrade = input.connection?.toLowerCase().split(/\s*,\s*/).includes("upgrade");
  if (input.path !== "/ws" || input.origin !== input.expectedOrigin
    || input.upgrade?.toLowerCase() !== "websocket" || !hasUpgrade || !validKey || !key) return undefined;
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    "\r\n",
  ].join("\r\n");
}

export function encodeWebSocketFrame(payload: string, opcode = 0x1): Buffer {
  const body = Buffer.from(payload, "utf8");
  if (body.length <= 125) {
    const frame = Buffer.allocUnsafe(2 + body.length);
    frame[0] = 0x80 | opcode;
    frame[1] = body.length;
    body.copy(frame, 2);
    return frame;
  }
  if (body.length <= 0xffff) {
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame[0] = 0x80 | opcode;
    frame[1] = 126;
    frame.writeUInt16BE(body.length, 2);
    body.copy(frame, 4);
    return frame;
  }
  const frame = Buffer.allocUnsafe(10 + body.length);
  frame[0] = 0x80 | opcode;
  frame[1] = 127;
  frame.writeBigUInt64BE(BigInt(body.length), 2);
  body.copy(frame, 10);
  return frame;
}
