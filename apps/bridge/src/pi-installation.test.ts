import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPiArguments, resolvePiInstallation } from "./pi-installation.ts";

function makePiPackage(packageRoot: string) {
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    version: "1.1.0",
    main: "./dist/index.js",
    bin: { pi: "dist/cli.js" },
    exports: { ".": { import: "./dist/index.js" } },
  }));
  writeFileSync(join(packageRoot, "dist", "cli.js"), "");
  writeFileSync(join(packageRoot, "dist", "index.js"), "");
}

test("prefers the project-pinned Pi package when it is installed", () => {
  const temp = mkdtempSync(join(os.tmpdir(), "voicepilot-pi-local-"));
  try {
    const localPackage = join(temp, "tools", "pi", "node_modules", "@earendil-works", "pi-coding-agent");
    makePiPackage(localPackage);

    assert.deepEqual(resolvePiInstallation(temp, {}, temp), {
      packageRoot: localPackage,
      cliPath: join(localPackage, "dist", "cli.js"),
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("prefers VoicePilot's direct-MCP computer-use adapter over the daemon-backed extension", () => {
  const temp = mkdtempSync(join(os.tmpdir(), "voicepilot-pi-direct-cua-"));
  try {
    const packageRoot = join(temp, "tools", "pi", "node_modules", "@earendil-works", "pi-coding-agent");
    const directExtension = join(temp, "tools", "pi", "voicepilot-computer-use.mjs");
    const upstreamExtension = join(temp, "tools", "pi", "node_modules", "@amaster.ai", "pi-computer-use", "dist", "index.js");
    makePiPackage(packageRoot);
    mkdirSync(join(upstreamExtension, ".."), { recursive: true });
    writeFileSync(directExtension, "export default () => {};\n");
    writeFileSync(upstreamExtension, "export default () => {};\n");

    assert.equal(resolvePiInstallation(temp, {}, temp)?.computerUseExtensionPath, directExtension);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("discovers Pi from its managed Windows install when the project copy is absent", () => {
  const temp = mkdtempSync(join(os.tmpdir(), "voicepilot-pi-managed-"));
  try {
    const installRoot = join(temp, ".pi", "agent", "install");
    const packageRoot = join(installRoot, "releases", "1.1.0", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(join(installRoot, "current-version"), "1.1.0\n");
    makePiPackage(packageRoot);

    assert.deepEqual(resolvePiInstallation(temp, {}, temp), {
      packageRoot,
      cliPath: join(packageRoot, "dist", "cli.js"),
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("discovers the cached computer-use extension beside the managed Pi install", () => {
  const temp = mkdtempSync(join(os.tmpdir(), "voicepilot-pi-extension-"));
  try {
    const installRoot = join(temp, ".pi", "agent", "install");
    const packageRoot = join(installRoot, "releases", "1.1.0", "node_modules", "@earendil-works", "pi-coding-agent");
    const extensionPath = join(temp, ".pi", "agent", "npm", "node_modules", "@amaster.ai", "pi-computer-use", "dist", "index.js");
    mkdirSync(installRoot, { recursive: true });
    mkdirSync(join(extensionPath, ".."), { recursive: true });
    writeFileSync(join(installRoot, "current-version"), "1.1.0\n");
    writeFileSync(extensionPath, "export default () => {};\n");
    makePiPackage(packageRoot);

    assert.equal(resolvePiInstallation(temp, {}, temp)?.computerUseExtensionPath, extensionPath);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("discovers the pinned Kilo provider extension from the project Pi runtime", () => {
  const temp = mkdtempSync(join(os.tmpdir(), "voicepilot-pi-kilo-"));
  try {
    const packageRoot = join(temp, "tools", "pi", "node_modules", "@earendil-works", "pi-coding-agent");
    const kiloRoot = join(temp, "tools", "pi", "node_modules", "pi-kilocode");
    const kiloExtensionPath = join(kiloRoot, "src", "index.ts");
    mkdirSync(join(kiloRoot, "src"), { recursive: true });
    writeFileSync(join(kiloRoot, "package.json"), JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }));
    writeFileSync(kiloExtensionPath, "export default () => {};\n");
    makePiPackage(packageRoot);

    assert.equal(resolvePiInstallation(temp, {}, temp)?.kiloCodeExtensionPath, kiloExtensionPath);
    assert.deepEqual(buildPiArguments(undefined, undefined, kiloExtensionPath), [
      "--no-session", "--no-builtin-tools", "--no-mcp", "--no-extensions",
      "--extension", kiloExtensionPath,
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("discovers and loads the project-owned approval gate extension", () => {
  const temp = mkdtempSync(join(os.tmpdir(), "voicepilot-pi-approval-"));
  try {
    const packageRoot = join(temp, "tools", "pi", "node_modules", "@earendil-works", "pi-coding-agent");
    const approvalPath = join(temp, "tools", "pi", "voicepilot-approval.mjs");
    makePiPackage(packageRoot);
    writeFileSync(approvalPath, "export default () => {};\n");

    assert.equal(resolvePiInstallation(temp, {}, temp)?.approvalExtensionPath, approvalPath);
    assert.deepEqual(buildPiArguments("computer-use.js", approvalPath), [
      "--no-session", "--no-builtin-tools", "--no-mcp", "--no-extensions",
      "--extension", "computer-use.js",
      "--extension", approvalPath,
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("returns no Pi installation when neither local nor managed package is available", () => {
  const temp = mkdtempSync(join(os.tmpdir(), "voicepilot-pi-missing-"));
  try {
    assert.equal(resolvePiInstallation(temp, {}, temp), undefined);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("loads the cached computer-use extension without enabling Pi built-in tools", () => {
  assert.deepEqual(buildPiArguments("C:\\voicepilot\\computer-use\\dist\\index.js"), [
    "--no-session",
    "--no-builtin-tools",
    "--no-mcp",
    "--no-extensions",
    "--extension",
    "C:\\voicepilot\\computer-use\\dist\\index.js",
  ]);
});

test("keeps Pi built-in tools disabled when no computer-use extension is found", () => {
  assert.deepEqual(buildPiArguments(undefined), ["--no-session", "--no-builtin-tools", "--no-mcp", "--no-extensions"]);
});
