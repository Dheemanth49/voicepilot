import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("Windows source bundle contains installer inputs but excludes local secrets and caches", async () => {
  const base = resolve(".tmp", "voicepilot-package");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "source-"));
  const output = join(root, "output");
  const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script = resolve("scripts", "package-windows.ps1");
  const add = (path, content = "fixture") => {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
  };
  for (const directory of ["apps", "packages", "scripts", "services", "tools/pi", "docs", "VoicePilot_Docs"]) mkdirSync(join(root, directory), { recursive: true });
  add("package.json", JSON.stringify({ version: "0.1.0" }));
  add("package-lock.json", "{}");
  add("README.md"); add(".env.example", "VOICEPILOT_GLOBAL_HOTKEY_ENABLED=0\n"); add(".env", "SECRET=do-not-package");
  add("apps/ui/src/App.tsx"); add("scripts/install-windows.ps1", readFileSync(resolve("scripts", "install-windows.ps1"), "utf8")); add("tools/pi/package-lock.json");
  add("node_modules/private-package/index.js"); add("tools/pi/node_modules/private-package/index.js");
  add(".data/models/weights.bin"); add(".voicepilot-file-search/venv/Scripts/python.exe");
  try {
    execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", script, "-ProjectRoot", root, "-OutputDirectory", output], { encoding: "utf8", windowsHide: true });
    const archive = join(output, "VoicePilot-0.1.0-windows.zip");
    const list = execFileSync("python", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(z.namelist()))", archive], { encoding: "utf8" });
    assert.match(list, /package-lock\.json/);
    assert.match(list, /apps\/ui\/src\/App\.tsx/);
    assert.match(list, /scripts\/install-windows\.ps1/);
    assert.match(list, /tools\/pi\/package-lock\.json/);
    assert.match(list, /^\.env\.example$/m);
    assert.doesNotMatch(list, /(^|\/)\.env$/m);
    assert.doesNotMatch(list, /node_modules|\.data|\.voicepilot-file-search/);

    const extracted = join(root, "extracted");
    mkdirSync(extracted);
    execFileSync("python", ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", archive, extracted], { encoding: "utf8" });
    const mockBin = join(root, "mock-bin");
    mkdirSync(mockBin);
    const installLog = join(root, "install.log");
    writeFileSync(join(mockBin, "npm.cmd"), `@echo off\r\necho %*>>"${installLog}"\r\nexit /b 0\r\n`, "utf8");
    const installOutput = execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(extracted, "scripts", "install-windows.ps1"), "-ProjectRoot", extracted], {
      encoding: "utf8", windowsHide: true, input: "n\nn\n",
      env: { ...process.env, PATH: `${mockBin};${process.env.PATH}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    });
    assert.deepEqual(readFileSync(installLog, "utf8").trim().split(/\r?\n/), ["ci", "run setup:pi"]);
    assert.match(installOutput, /Setup complete/i);
    assert.match(readFileSync(join(extracted, ".env"), "utf8"), /^VOICEPILOT_GLOBAL_HOTKEY_ENABLED=1$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
