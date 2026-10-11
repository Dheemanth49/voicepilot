import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import { toPiToolResult } from "./node_modules/@amaster.ai/pi-computer-use/dist/tool-result.js";
import { createCloseAppTool, selectWindow } from "./voicepilot-close-app.mjs";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(extensionRoot, "..", "..");
const CORE_TOOLS = new Set([
  "list_apps", "list_windows", "launch_app", "bring_to_front", "get_window_state", "verify_state", "click",
  "double_click", "right_click", "drag", "type_text", "press_key", "hotkey",
  "set_value", "scroll", "zoom",
]);

export function createComputerUseExtension({ createClient = createDirectMcpClient } = {}) {
  return (pi) => {
    let client;
    let sessionSignal;
    let connecting;
    const registeredTools = new Set();
    let recoverySurfaceRegistered = false;

    pi.registerTool(createCloseAppTool({
      environment: process.env,
      async callTool(name, args, signal) {
        if (!client) throw new Error("The direct CUA connection is unavailable. Restart VoicePilot to reconnect.");
        return client.callTool(name, args, signal ?? sessionSignal);
      },
      async authorize(input, signal) {
        const token = process.env.VOICEPILOT_APPROVAL_TOKEN;
        const bridgeUrl = (process.env.VOICEPILOT_APPROVAL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
        if (typeof token !== "string" || token.length < 32) return { ok: false, message: "VoicePilot could not authorize this app close request." };
        try {
          const response = await fetch(`${bridgeUrl}/api/internal/actions/authorize`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(input),
            signal,
          });
          let result = {};
          try { result = await response.json(); } catch { /* The bridge may return an empty error body. */ }
          return { ok: response.ok && result.status === "authorized", message: result.error?.message };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : "VoicePilot could not reach the local bridge." };
        }
      },
    }));
    pi.registerCommand("voicepilot-close-app", {
      description: "Reports that VoicePilot's verified app-window close tool is available.",
      handler: (_args, context) => context.ui.notify("VoicePilot can close the named app window and verify it disappeared.", "info"),
    });

    const registerLiveTools = (tools) => {
      if (!Array.isArray(tools)) throw new Error("CUA returned an invalid tools list.");
      let count = 0;
      for (const tool of tools) {
        if (!tool || !CORE_TOOLS.has(tool.name) || registeredTools.has(tool.name)) continue;
        if (!tool.inputSchema || typeof tool.inputSchema !== "object") continue;
        const driverName = tool.name;
        const piName = `computer_use_${driverName}`;
        pi.registerTool({
          name: piName,
          label: piName,
          description: tool.description ?? "",
          parameters: Type.Unsafe(tool.inputSchema),
          async execute(_callId, args, signal) {
            if (!client) return toolError("The direct CUA connection is unavailable. Restart VoicePilot to reconnect.");
            const activeClient = client;
            try {
              const result = await activeClient.callTool(driverName, args, signal ?? sessionSignal);
              if (driverName === "launch_app" && !result?.isError) {
                const target = getLaunchTarget(args);
                try {
                  const window = await bringLaunchedWindowToFront(activeClient, target, result, signal ?? sessionSignal);
                  return {
                    ...result,
                    content: [...(result.content ?? []), { type: "text", text: `VoicePilot brought ${target} to the foreground.` }],
                    structuredContent: { ...(result.structuredContent ?? {}), foreground: true, foregroundWindowId: window.window_id },
                  };
                } catch (error) {
                  return toolError(`The app launched, but VoicePilot could not bring it to the foreground: ${error instanceof Error ? error.message : "window activation failed"}`);
                }
              }
              return toPiToolResult(result, driverName);
            } catch (error) {
              await discard(activeClient);
              return toolError(error instanceof Error ? error.message : "The CUA driver connection was lost.");
            }
          },
        });
        registeredTools.add(driverName);
        count += 1;
      }
      if (count > 0) {
        pi.registerCommand("computer-use-tools", {
          description: "Reports that VoicePilot's direct computer-use tool surface is ready.",
          handler: (_args, context) => context.ui.notify("VoicePilot computer-use tools are connected through direct MCP.", "info"),
        });
      }
      return count;
    };

    const discard = async (activeClient) => {
      if (client === activeClient) client = undefined;
      await discardClient(activeClient);
    };

    const discover = async (signal) => {
      if (connecting) return connecting;
      connecting = (async () => {
        if (!client) client = createClient();
        const activeClient = client;
        try {
          await activeClient.connect(signal);
          const response = await activeClient.listTools(signal);
          const count = registerLiveTools(response.tools);
          if (count === 0 && registeredTools.size === 0) throw new Error("The CUA driver did not expose any VoicePilot core tools.");
          return count || registeredTools.size;
        } catch (error) {
          await discard(activeClient);
          throw error;
        }
      })();
      try {
        return await connecting;
      } finally {
        connecting = undefined;
      }
    };

    const registerRecoverySurface = () => {
      if (recoverySurfaceRegistered) return;
      recoverySurfaceRegistered = true;
      pi.registerTool({
        name: "computer_use_connect",
        label: "computer_use_connect",
        description: "Retry direct MCP connection to VoicePilot's bundled Windows CUA driver and register its core tools.",
        parameters: Type.Object({}),
        async execute(_callId, _args, signal) {
          try {
            const count = await discover(signal ?? sessionSignal);
            return { content: [{ type: "text", text: `Connected to the CUA driver and registered ${count} core tools.` }] };
          } catch (error) {
            return toolError(error instanceof Error ? error.message : "The CUA driver is still unavailable.");
          }
        },
      });
      pi.registerCommand("computer-use-connect", {
        description: "Retry the direct VoicePilot computer-use connection.",
        async handler(_args, context) {
          try {
            const count = await discover(context.signal ?? sessionSignal);
            context.ui.notify(`VoicePilot connected to the CUA driver and registered ${count} core tools.`, "info");
          } catch (error) {
            context.ui.notify(`VoicePilot computer-use is still unavailable: ${error instanceof Error ? error.message : "driver error"}`, "warning");
          }
        },
      });
    };

    pi.on("session_start", async (_event, context) => {
      sessionSignal = context.signal;
      client = undefined;
      connecting = undefined;
      registeredTools.clear();
      recoverySurfaceRegistered = false;
      try {
        await discover(sessionSignal);
      } catch (error) {
        registerRecoverySurface();
        console.error(`[voicepilot-computer-use] direct CUA startup failed: ${error instanceof Error ? error.message : "driver error"}`);
      }
    });

    pi.on("session_shutdown", async () => {
      sessionSignal = undefined;
      connecting = undefined;
      const closingClient = client;
      client = undefined;
      await closingClient?.close().catch(() => undefined);
    });
  };
}

export default createComputerUseExtension();

function createDirectMcpClient() {
  const override = process.env.VOICEPILOT_CUA_DRIVER_PATH;
  const executable = override
    ? resolve(projectRoot, override)
    : resolve(extensionRoot, "node_modules", "@amaster.ai", "pi-computer-use-cua-driver-win32-x64", "bin", "cua-driver.exe");
  const transport = new StdioClientTransport({
    command: executable,
    args: ["mcp", "--direct"],
    cwd: projectRoot,
    env: process.env,
    stderr: "ignore",
  });
  const mcp = new Client({ name: "voicepilot-computer-use", version: "0.1.0" }, { capabilities: {} });
  return {
    connect: (signal) => mcp.connect(transport, signal ? { signal } : undefined),
    listTools: (signal) => mcp.listTools(undefined, signal ? { signal } : undefined),
    callTool: (name, args, signal) => mcp.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined),
    close: () => mcp.close(),
  };
}

async function discardClient(activeClient) {
  try { await activeClient.close(); } catch { /* A failed MCP transport may already be closed. */ }
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

function getLaunchTarget(args) {
  for (const key of ["name", "app", "application", "executable", "app_id", "appid", "bundle_id", "bundleid", "target"]) {
    if (typeof args?.[key] === "string" && args[key].trim()) return args[key].trim();
  }
  return "the requested app";
}

async function bringLaunchedWindowToFront(client, target, launchResult, signal) {
  const launchedPid = Number.isInteger(launchResult?.structuredContent?.pid)
    ? launchResult.structuredContent.pid
    : undefined;
  let selected;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const listed = await client.callTool("list_windows", { on_screen_only: true }, signal);
    if (listed?.isError) throw new Error(readToolError(listed) ?? "The CUA driver could not list visible windows.");
    const windows = readWindowList(listed);
    selected = launchedPid
      ? windows.find((window) => window.pid === launchedPid && window.is_on_screen === true)
      : selectWindow(windows, target);
    if (selected && Number.isInteger(selected.pid) && Number.isInteger(selected.window_id)) break;
    selected = undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!selected) throw new Error("The launched app has no visible window to activate yet.");
  const focused = await client.callTool("bring_to_front", { pid: selected.pid, window_id: selected.window_id }, signal);
  if (focused?.isError) throw new Error(readToolError(focused) ?? "The CUA driver rejected the window activation request.");
  return selected;
}

function readWindowList(result) {
  let windows = result?.structuredContent?.windows;
  if (!Array.isArray(windows)) {
    for (const item of result?.content ?? []) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed = JSON.parse(item.text);
        windows = Array.isArray(parsed) ? parsed : parsed.windows;
        if (Array.isArray(windows)) break;
      } catch { /* Ignore non-JSON text blocks. */ }
    }
  }
  if (!Array.isArray(windows)) throw new Error("The CUA driver returned no structured window list.");
  return windows;
}

function readToolError(result) {
  return result?.content?.find((item) => item?.type === "text" && typeof item.text === "string")?.text;
}
