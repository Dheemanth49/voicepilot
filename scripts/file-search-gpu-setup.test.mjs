import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const powershell = process.env.POWERSHELL_EXE ?? "powershell.exe";
const modulePath = resolve("scripts", "voicepilot-setup-common.psm1");

function runPowerShell(command) {
  return execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

test("selects a CUDA wheel compatible with detected NVIDIA driver range", () => {
  assert.equal(runPowerShell(`Import-Module '${modulePath}' -Force; Get-VoicePilotCudaFlavor -DriverVersion '579.99'`), "cu126");
  assert.equal(runPowerShell(`Import-Module '${modulePath}' -Force; Get-VoicePilotCudaFlavor -DriverVersion '580.00'`), "cu130");
  assert.equal(runPowerShell(`Import-Module '${modulePath}' -Force; try { Get-VoicePilotCudaFlavor -DriverVersion '524.99'; 'accepted' } catch { 'rejected' }`), "rejected");
});

test("updates only requested VoicePilot environment keys and preserves unrelated values", () => {
  const fixtureRoot = resolve(".tmp", "voicepilot-setup");
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "fixture-"));
  const envPath = join(directory, ".env");
  writeFileSync(envPath, "# keep this comment\r\nVOICEPILOT_FILE_SEARCH_ENABLED=1\r\nOTHER_SETTING=keep\r\n", "utf8");
  try {
    runPowerShell(`Import-Module '${modulePath}' -Force; Set-VoicePilotEnvValues -Path '${envPath}' -Values @{VOICEPILOT_FILE_SEARCH_DEVICE='auto';VOICEPILOT_FILE_SEARCH_PYTHON='gpu-python.exe'}`);
    const result = readFileSync(envPath, "utf8");
    assert.match(result, /^# keep this comment\r?\n/m);
    assert.match(result, /^VOICEPILOT_FILE_SEARCH_ENABLED=1\r?\n/m);
    assert.match(result, /^OTHER_SETTING=keep\r?\n/m);
    assert.match(result, /^VOICEPILOT_FILE_SEARCH_DEVICE=auto\r?\n/m);
    assert.match(result, /^VOICEPILOT_FILE_SEARCH_PYTHON=gpu-python\.exe\r?\n/m);
    assert.equal((result.match(/^VOICEPILOT_FILE_SEARCH_DEVICE=/gm) ?? []).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GPU setup rejects an old driver before changing the existing CPU configuration", () => {
  const fixtureRoot = resolve(".tmp", "voicepilot-setup");
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "installer-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const originalEnv = "VOICEPILOT_FILE_SEARCH_ENABLED=1\r\nVOICEPILOT_FILE_SEARCH_PYTHON=cpu-python.exe\r\nVOICEPILOT_FILE_SEARCH_DEVICE=cpu\r\n";
  writeFileSync(join(directory, ".env"), originalEnv, "utf8");
  writeFileSync(join(bin, "nvidia-smi.cmd"), "@echo off\r\necho NVIDIA GeForce RTX 4060, 524.99, 8192 MiB\r\n", "utf8");
  const system32 = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
  const windowsPowerShell = `${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const installer = resolve("scripts", "install-file-search.ps1");
  try {
    assert.throws(() => execFileSync(windowsPowerShell, [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", installer,
      "-Gpu", "-ProjectRoot", directory,
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PATH: `${bin};${system32}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    }), /driver 524\.99/i);
    assert.equal(readFileSync(join(directory, ".env"), "utf8"), originalEnv);
    assert.equal(existsSync(join(directory, ".voicepilot-file-search", "venv-gpu")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
