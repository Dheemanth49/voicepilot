import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFile = promisify(execFileCallback);
const VOLUME_TOLERANCE_PERCENT = 1;

type VolumeOptions = {
  platform?: NodeJS.Platform;
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
  runScript?: (scriptPath: string, level: number) => Promise<string>;
};

export async function setWindowsSystemVolume(level: number, options: VolumeOptions = {}): Promise<number> {
  if (!Number.isInteger(level) || level < 0 || level > 100) {
    throw new RangeError("Volume level must be an integer between 0 and 100.");
  }
  if ((options.platform ?? process.platform) !== "win32") {
    throw new Error("System volume control is available on Windows only.");
  }

  const scriptPath = resolve(options.projectRoot ?? process.cwd(), "scripts", "set-windows-volume.ps1");
  const output = await (options.runScript ?? runVolumeScript)(scriptPath, level);
  let result: unknown;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error("Windows volume control returned an invalid read-back value.");
  }
  const actual = result && typeof result === "object" ? (result as { level?: unknown }).level : undefined;
  if (typeof actual !== "number" || !Number.isFinite(actual) || actual < 0 || actual > 100
    || Math.abs(actual - level) > VOLUME_TOLERANCE_PERCENT) {
    throw new Error(`Windows could not verify the requested ${level}% volume level.`);
  }
  return actual;
}

async function runVolumeScript(scriptPath: string, level: number): Promise<string> {
  const windir = process.env.WINDIR ?? "C:\\Windows";
  const powershell = resolve(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFile(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Level", String(level),
  ], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
  return stdout;
}
