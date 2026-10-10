import assert from "node:assert/strict";
import { test } from "node:test";
import { stopServices } from "./shutdown.js";

test("shutdown attempts every service even when one stop fails", async () => {
  const called: string[] = [];
  const errors = await stopServices([
    async () => { called.push("pi"); },
    async () => { called.push("speech"); throw new Error("speech child did not exit"); },
    async () => { called.push("file-search"); },
  ]);
  assert.deepEqual(called, ["pi", "speech", "file-search"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /speech child did not exit/);
});

test("shutdown supports synchronous process cleanup handlers", async () => {
  let killed = false;
  const errors = await stopServices([() => { killed = true; }]);
  assert.equal(killed, true);
  assert.deepEqual(errors, []);
});
