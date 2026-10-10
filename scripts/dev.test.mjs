import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findAvailablePort } from "./dev.mjs";

test("finds an available loopback port from the preferred port", async () => {
  const selected = await findAvailablePort(0);
  assert.ok(Number.isInteger(selected));
  assert.ok(selected > 0);
});

test("skips a loopback port that is already occupied", async () => {
  const probed = [];
  const selected = await findAvailablePort(8787, 3, async (port) => {
    probed.push(port);
    return port === 8787 ? undefined : port;
  });
  assert.equal(selected, 8788);
  assert.deepEqual(probed, [8787, 8788]);
});

test("visible Brave CDP launcher uses the normal profile by default and never starts headless", async () => {
  const script = await readFile(new URL("./start-browser-cdp.ps1", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(script, /--remote-debugging-port/);
  assert.match(script, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(script, /--remote-allow-origins=http:\/\/127\.0\.0\.1:/);
  assert.match(script, /UseVoicePilotProfile/);
  assert.match(script, /VOICEPILOT_BROWSER_CDP_ENDPOINT/);
  assert.match(script, /Find-VoicePilotUiUrl/);
  assert.match(script, /@vite\/client/);
  assert.match(script, /\/json\/new\?/);
  assert.doesNotMatch(script, /about:blank/);
  assert.doesNotMatch(script, /--headless/);
  assert.doesNotMatch(script, /Stop-Process/);
  assert.match(packageJson.scripts["start:browser"], /start-browser-cdp\.ps1/);
});
