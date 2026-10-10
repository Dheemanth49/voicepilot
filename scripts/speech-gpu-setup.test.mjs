import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("speech GPU setup rejects an old NVIDIA driver without changing CPU selection", () => {
  const fixtureRoot = resolve(".tmp", "voicepilot-speech-gpu");
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "installer-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const originalEnv = "VOICEPILOT_STT_ENABLED=1\r\nVOICEPILOT_PYTHON=cpu-python.exe\r\nVOICEPILOT_STT_DEVICE=cpu\r\n";
  writeFileSync(join(directory, ".env"), originalEnv, "utf8");
  writeFileSync(join(bin, "nvidia-smi.cmd"), "@echo off\r\necho NVIDIA GeForce RTX 4060, 524.99, 8192 MiB\r\n", "utf8");
  const system32 = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
  const powershell = `${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const installer = resolve("scripts", "install-speech-gpu-runtime.ps1");
  try {
    assert.throws(() => execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", installer, "-ProjectRoot", directory], {
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, PATH: `${bin};${system32}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    }), /driver 524\.99/i);
    assert.equal(readFileSync(join(directory, ".env"), "utf8"), originalEnv);
    assert.equal(existsSync(join(directory, ".voicepilot-speech", "venv-gpu")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
