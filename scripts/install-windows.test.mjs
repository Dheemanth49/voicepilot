import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const fixtureBase = resolve(".tmp", "voicepilot-bootstrap");
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const installer = resolve("scripts", "install-windows.ps1");

function createFixture() {
  mkdirSync(fixtureBase, { recursive: true });
  const root = mkdtempSync(join(fixtureBase, "fixture-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(join(root, ".env.example"), "VOICEPILOT_GLOBAL_HOTKEY_ENABLED=0\n", "utf8");
  const log = join(root, "npm.log");
  const npmShim = [
    "@echo off",
    `echo %*>>"${log}"`,
    'if "%VOICEPILOT_FAIL_CI%"=="1" if "%~1"=="ci" exit /b 17',
    "exit /b 0",
    "",
  ].join("\r\n");
  writeFileSync(join(bin, "npm.cmd"), npmShim, "utf8");
  return { root, bin, log };
}

function runInstaller(fixture, failCi = false) {
  return execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, "-ProjectRoot", fixture.root], {
    encoding: "utf8",
    windowsHide: true,
    input: "n\nn\n",
    env: {
      ...process.env,
      PATH: `${fixture.bin};${process.env.PATH}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      VOICEPILOT_FAIL_CI: failCi ? "1" : "0",
    },
  });
}

test("Windows bootstrap installs root npm dependencies before configuring Pi and hotkey", () => {
  const fixture = createFixture();
  try {
    const output = runInstaller(fixture);
    const calls = readFileSync(fixture.log, "utf8").trim().split(/\r?\n/);
    assert.deepEqual(calls.slice(0, 2), ["ci", "run setup:pi"]);
    assert.match(output, /Setup complete/i);
    assert.match(readFileSync(join(fixture.root, ".env"), "utf8"), /^VOICEPILOT_GLOBAL_HOTKEY_ENABLED=1$/m);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("bootstrap stops before Pi setup when root npm dependency installation fails", () => {
  const fixture = createFixture();
  try {
    assert.throws(() => runInstaller(fixture, true), /npm ci failed|dependencies could not be installed/i);
    const calls = readFileSync(fixture.log, "utf8").trim().split(/\r?\n/);
    assert.deepEqual(calls, ["ci"]);
    assert.doesNotMatch(readFileSync(join(fixture.root, ".env"), "utf8"), /^VOICEPILOT_GLOBAL_HOTKEY_ENABLED=1$/m);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
