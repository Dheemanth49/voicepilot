import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devInfoPath = resolve(projectRoot, ".voicepilot-dev.json");

export async function findAvailablePort(preferredPort, attempts = 100, portProbe = probePort) {
  if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65_535) {
    throw new RangeError("The preferred port must be an integer from 0 to 65535.");
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("Port scan attempts must be a positive integer.");
  }

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = preferredPort === 0 ? 0 : preferredPort + offset;
    if (candidate > 65_535) break;
    const availablePort = await portProbe(candidate);
    if (availablePort !== undefined) return availablePort;
    if (preferredPort === 0) break;
  }
  throw new Error(`Could not find an available loopback port starting at ${preferredPort}.`);
}

function probePort(port) {
  const server = createServer();
  return new Promise((resolveProbe, rejectProbe) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") return resolveProbe(undefined);
      rejectProbe(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const address = server.address();
      const selectedPort = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? rejectProbe(error) : resolveProbe(selectedPort));
    });
  });
}

async function start() {
  const bridgePort = await findAvailablePort(8787);
  const uiPort = await findAvailablePort(5173);
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  writeFileSync(devInfoPath, JSON.stringify({ uiOrigin, bridgeUrl, startedAt: new Date().toISOString() }, null, 2));
  const children = [];
  let stopping = false;

  const stopChild = (child) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => child.kill());
    } else {
      child.kill("SIGTERM");
    }
  };

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    try {
      rmSync(devInfoPath, { force: true });
    } catch {
      // A stale discovery file is harmless; the browser launcher verifies the UI before using it.
    }
    for (const child of children) stopChild(child);
  };

  const launch = (label, commandArgs, cwd, env) => {
    const [command, ...args] = commandArgs;
    const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: false });
    children.push(child);
    child.once("error", (error) => {
      console.error(`[${label}] could not start: ${error.message}`);
      process.exitCode = 1;
      shutdown();
    });
    child.once("exit", (code, signal) => {
      if (stopping) return;
      console.error(`[${label}] stopped${signal ? ` after ${signal}` : ` with code ${code ?? 1}`}.`);
      process.exitCode = code && code > 0 ? code : 1;
      shutdown();
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`VoicePilot UI:     ${uiOrigin}`);
  console.log(`VoicePilot bridge: ${bridgeUrl}`);
  console.log("Press Ctrl+C to stop both services.");

  const nodeModules = resolve(projectRoot, "node_modules");
  launch(
    "bridge",
    [process.execPath, resolve(nodeModules, "tsx/dist/cli.mjs"), "watch", "src/server.ts"],
    resolve(projectRoot, "apps/bridge"),
    { ...process.env, VOICEPILOT_HOST: "127.0.0.1", VOICEPILOT_PORT: String(bridgePort), VOICEPILOT_UI_ORIGIN: uiOrigin },
  );
  launch(
    "ui",
    [process.execPath, resolve(nodeModules, "vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(uiPort), "--strictPort"],
    resolve(projectRoot, "apps/ui"),
    { ...process.env, VITE_BRIDGE_URL: bridgeUrl },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start().catch((error) => {
    console.error(`VoicePilot development launcher failed: ${error.message}`);
    process.exitCode = 1;
  });
}
