import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PiInstallation {
  packageRoot: string;
  cliPath: string;
  computerUseExtensionPath?: string;
  approvalExtensionPath?: string;
  kiloCodeExtensionPath?: string;
  browserExtensionPath?: string;
  fileSearchExtensionPath?: string;
}

export function buildPiArguments(
  computerUseExtensionPath?: string,
  approvalExtensionPath?: string,
  kiloCodeExtensionPath?: string,
  browserExtensionPath?: string,
  fileSearchExtensionPath?: string,
): string[] {
  const args = ["--no-session", "--no-builtin-tools", "--no-mcp", "--no-extensions"];
  if (computerUseExtensionPath) args.push("--extension", computerUseExtensionPath);
  if (approvalExtensionPath) args.push("--extension", approvalExtensionPath);
  if (kiloCodeExtensionPath) args.push("--extension", kiloCodeExtensionPath);
  if (browserExtensionPath) args.push("--extension", browserExtensionPath);
  if (fileSearchExtensionPath) args.push("--extension", fileSearchExtensionPath);
  return args;
}

type PiPackageMetadata = {
  bin?: string | Record<string, string>;
};

type PiExtensionPackageMetadata = {
  pi?: { extensions?: string[] };
};

function findPiExtension(packageRoot: string): string | undefined {
  const packageJsonPath = resolve(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PiExtensionPackageMetadata;
    return metadata.pi?.extensions
      ?.map((entry) => resolve(packageRoot, entry))
      .find((path) => existsSync(path));
  } catch {
    return undefined;
  }
}

const PI_PACKAGE = join("node_modules", "@earendil-works", "pi-coding-agent");

export function resolvePiInstallation(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): PiInstallation | undefined {
  const packageRoots = [
    resolve(projectRoot, "tools", "pi", PI_PACKAGE),
    env.VOICEPILOT_PI_PACKAGE_ROOT,
  ].filter((path): path is string => Boolean(path));

  const agentHome = env.VOICEPILOT_PI_AGENT_HOME ?? env.PI_CODING_AGENT_DIR ?? join(userHome, ".pi", "agent");
  const managedInstallRoot = env.VOICEPILOT_PI_INSTALL_ROOT ?? join(agentHome, "install");
  const extensionCandidates = [
    env.VOICEPILOT_PI_COMPUTER_USE_EXTENSION,
    resolve(projectRoot, "tools", "pi", "voicepilot-computer-use.mjs"),
    resolve(projectRoot, ".pi", "extensions", "pi-computer-use", "dist", "index.js"),
    resolve(projectRoot, "node_modules", "@amaster.ai", "pi-computer-use", "dist", "index.js"),
    resolve(projectRoot, "tools", "pi", "node_modules", "@amaster.ai", "pi-computer-use", "dist", "index.js"),
    resolve(agentHome, "npm", "node_modules", "@amaster.ai", "pi-computer-use", "dist", "index.js"),
  ];
  const computerUseExtensionPath = extensionCandidates.find((path): path is string => typeof path === "string" && existsSync(path));
  const approvalExtensionPath = resolve(projectRoot, "tools", "pi", "voicepilot-approval.mjs");
  const browserExtensionPath = resolve(projectRoot, "tools", "pi", "voicepilot-browser.mjs");
  const fileSearchExtensionPath = resolve(projectRoot, "tools", "pi", "voicepilot-file-search.mjs");
  const kiloCodeExtensionPath = [
    resolve(projectRoot, "tools", "pi", "node_modules", "pi-kilocode"),
    resolve(agentHome, "npm", "node_modules", "pi-kilocode"),
  ].map(findPiExtension).find((path): path is string => Boolean(path));
  const currentVersionFile = join(managedInstallRoot, "current-version");
  if (existsSync(currentVersionFile)) {
    const version = readFileSync(currentVersionFile, "utf8").trim();
    if (/^[0-9A-Za-z._+-]+$/.test(version)) {
      packageRoots.push(resolve(managedInstallRoot, "releases", version, PI_PACKAGE));
    }
  }

  for (const packageRoot of packageRoots) {
    const packageJsonPath = resolve(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) continue;

    let metadata: PiPackageMetadata;
    try {
      metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PiPackageMetadata;
    } catch {
      continue;
    }

    const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pi;
    if (!bin) continue;
    const cliPath = resolve(packageRoot, bin);
    if (!cliPath.startsWith(`${resolve(packageRoot)}\\`) || !existsSync(cliPath)) continue;
    return {
      packageRoot: resolve(packageRoot),
      cliPath,
      ...(computerUseExtensionPath ? { computerUseExtensionPath: resolve(computerUseExtensionPath) } : {}),
      ...(existsSync(approvalExtensionPath) ? { approvalExtensionPath } : {}),
      ...(kiloCodeExtensionPath ? { kiloCodeExtensionPath } : {}),
      ...(existsSync(browserExtensionPath) ? { browserExtensionPath } : {}),
      ...(existsSync(fileSearchExtensionPath) ? { fileSearchExtensionPath } : {}),
    };
  }

  return undefined;
}
