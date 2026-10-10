import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ProviderStatus } from "../../../packages/contracts/src/index.js";
import { appTargetsMatch, getRequestedAppName, type RequestedBrowserTask, type RequestedScroll } from "./task-policy.js";
import { buildPiArguments, resolvePiInstallation } from "./pi-installation.js";

type JsonRecord = Record<string, unknown>;
export type PiRpcEvent = {
  type?: string;
  aborted?: boolean;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  message?: JsonRecord;
};
type PiRpcClientInstance = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): Promise<unknown>;
  getCommands(): Promise<Array<{ name: string; description?: string }>>;
  abort(): Promise<void>;
  promptAndWait(message: string, images?: unknown[], timeout?: number): Promise<PiRpcEvent[]>;
};
type PiRpcClientConstructor = new (options: {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => PiRpcClientInstance;

export interface PiTaskResult {
  text: string;
  computerUseSucceeded: boolean;
  volumeSetSucceeded: boolean;
  browserTaskSucceeded: boolean;
  scrollSucceeded: boolean;
  scrollActionId?: string;
  closeAppSucceeded: boolean;
  closeAppActionId?: string;
  volumeSetActionId?: string;
  cancelled: boolean;
}

const START_TIMEOUT_MS = 15_000;
const TASK_TIMEOUT_MS = 180_000;

export class PiRpcClient {
  private client: PiRpcClientInstance | undefined;
  private starting: Promise<void> | undefined;
  private busy = false;
  private ready = false;
  private extensionCommands: Array<{ name: string; description?: string }> = [];
  failureReason: string | undefined;

  constructor(private readonly projectRoot: string, private readonly envOverrides: NodeJS.ProcessEnv = {}) {}

  get isReady() {
    return this.ready && this.client !== undefined;
  }

  get hasComputerUseExtension() {
    return Boolean(resolvePiInstallation(this.projectRoot)?.computerUseExtensionPath);
  }

  get hasApprovalExtension() {
    return Boolean(resolvePiInstallation(this.projectRoot)?.approvalExtensionPath);
  }

  get fileSearchToolsStatus(): ProviderStatus {
    if (!resolvePiInstallation(this.projectRoot)?.fileSearchExtensionPath) return "unavailable";
    if (!this.isReady) return "initializing";
    return this.extensionCommands.some((command) => command.name === "voicepilot-file-search") ? "available" : "misconfigured";
  }

  get approvalGateReady() {
    return this.isReady && this.hasApprovalExtension
      && this.extensionCommands.some((command) => command.name === "voicepilot-approval");
  }

  get desktopToolsStatus(): ProviderStatus {
    return getDesktopToolsStatus(this.isReady, this.hasComputerUseExtension, this.extensionCommands);
  }

  get desktopToolsFailureReason(): string | undefined {
    if (!this.hasComputerUseExtension) return "Pi's computer-use extension was not found. Run npm run setup:pi.";
    if (!this.isReady) return this.failureReason ?? "Pi RPC is still starting.";
    if (this.extensionCommands.some((command) => command.name === "computer-use-connect")) {
      return "Pi loaded the computer-use extension, but it could not connect to the CUA driver.";
    }
    if (!this.extensionCommands.some((command) => command.name === "computer-use-tools")) {
      return "Pi RPC is running, but the computer-use extension did not register its tool surface.";
    }
    return undefined;
  }

  get browserToolsStatus(): ProviderStatus {
    const installation = resolvePiInstallation(this.projectRoot);
    if (!installation?.browserExtensionPath) return "unavailable";
    const worker = resolve(this.projectRoot, "services", "browser", "laya_worker.py");
    const python = resolve(this.projectRoot, ".voicepilot-laya", "venv", "Scripts", "python.exe");
    if (!existsSync(worker) || !existsSync(python)) return "unavailable";
    if (!this.getBrowserCdpEndpoint()) return "misconfigured";
    if (!this.isReady) return "initializing";
    return this.extensionCommands.some((command) => command.name === "voicepilot-browser") ? "available" : "misconfigured";
  }

  get browserToolsFailureReason(): string | undefined {
    if (!resolvePiInstallation(this.projectRoot)?.browserExtensionPath) return "VoicePilot's Pi browser extension was not found.";
    const worker = resolve(this.projectRoot, "services", "browser", "laya_worker.py");
    const python = resolve(this.projectRoot, ".voicepilot-laya", "venv", "Scripts", "python.exe");
    if (!existsSync(worker) || !existsSync(python)) return "The optional Laya runtime is not installed. Run npm run setup:laya.";
    if (!this.getBrowserCdpEndpoint()) return "Set VOICEPILOT_BROWSER_CDP_ENDPOINT in .env to the local CDP endpoint of your browser started with remote debugging enabled.";
    if (!this.isReady) return this.failureReason ?? "Pi RPC is still starting.";
    if (!this.extensionCommands.some((command) => command.name === "voicepilot-browser")) return "Pi did not register VoicePilot's browser tool.";
    return undefined;
  }

  private getBrowserCdpEndpoint(): string | undefined {
    const raw = this.envOverrides.VOICEPILOT_BROWSER_CDP_ENDPOINT ?? process.env.VOICEPILOT_BROWSER_CDP_ENDPOINT;
    if (!raw?.trim()) return undefined;
    try {
      const endpoint = new URL(raw.trim());
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return undefined;
      if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(endpoint.hostname)) return undefined;
      return endpoint.toString().replace(/\/$/, "");
    } catch {
      return undefined;
    }
  }

  async start() {
    if (this.isReady) return;
    if (this.starting) return this.starting;
    this.starting = this.startClient();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startClient() {
    const installation = resolvePiInstallation(this.projectRoot);
    if (!installation) {
      this.failureReason = "Pi is not installed. Run npm run setup:pi or install Pi in the current Windows user profile.";
      throw new Error(this.failureReason);
    }

    const packageRoot = installation.packageRoot;
    const packageJsonPath = resolve(packageRoot, "package.json");
    const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      main?: string;
      exports?: Record<string, string | { import?: string; default?: string }>;
      bin?: string | Record<string, string>;
    };
    const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pi;
    const rootExport = metadata.exports?.["."];
    const clientEntry = typeof rootExport === "string"
      ? rootExport
      : rootExport?.import ?? rootExport?.default ?? metadata.main;
    if (!bin || !clientEntry) {
      this.failureReason = "The installed Pi package does not expose its expected CLI and RPC client.";
      throw new Error(this.failureReason);
    }

    const clientPath = resolve(packageRoot, clientEntry);
    if (!existsSync(clientPath)) {
      this.failureReason = "Pi's installed CLI or RPC client entry point is missing. Run npm run setup:pi again.";
      throw new Error(this.failureReason);
    }

    try {
      const piModule = await import(pathToFileURL(clientPath).href) as { RpcClient?: PiRpcClientConstructor };
      if (!piModule.RpcClient) throw new Error("The installed Pi package does not export RpcClient.");
      const client = new piModule.RpcClient({
        cliPath: installation.cliPath,
        args: buildPiArguments(
          installation.computerUseExtensionPath,
          installation.approvalExtensionPath,
          installation.kiloCodeExtensionPath,
          installation.browserExtensionPath,
          installation.fileSearchExtensionPath,
        ),
        cwd: this.projectRoot,
        env: { ...process.env, ...this.envOverrides, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
      });
      this.client = client;
      await client.start();
      let startupTimer: NodeJS.Timeout | undefined;
      let startupData: { commands: Array<{ name: string; description?: string }> };
      try {
        startupData = await Promise.race([
          Promise.all([client.getState(), client.getCommands()]).then(([, commands]) => ({ commands })),
          new Promise<never>((_, reject) => {
            startupTimer = setTimeout(() => reject(new Error("Pi RPC did not become ready within 15 seconds.")), START_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (startupTimer) clearTimeout(startupTimer);
      }
      this.extensionCommands = startupData.commands;
      this.failureReason = undefined;
      this.ready = true;
    } catch (error) {
      this.ready = false;
      this.extensionCommands = [];
      await this.client?.stop().catch(() => undefined);
      this.client = undefined;
      this.failureReason = error instanceof Error ? error.message : "Pi RPC did not become ready.";
      throw new Error(this.failureReason);
    }
  }

  async prompt(prompt: string, expectedApp?: string, expectedVolumeLevel?: number, expectedBrowserTask?: RequestedBrowserTask, expectedScroll?: RequestedScroll, expectedCloseApp?: string): Promise<PiTaskResult> {
    if (!this.isReady) await this.start();
    if (this.busy) throw new Error("VoicePilot is already processing another task. Wait for it to finish before submitting another.");
    const client = this.client;
    if (!client) throw new Error("Pi RPC process is not running.");
    this.busy = true;
    try {
      let events: PiRpcEvent[];
      try {
        events = await client.promptAndWait(prompt, undefined, TASK_TIMEOUT_MS);
      } catch (error) {
        await client.abort().catch(() => undefined);
        throw error;
      }

      let text = "";
      let failure: string | undefined;
      const requestedApp = expectedApp ?? getRequestedAppName(prompt) ?? "Notepad";
      const computerUseSucceeded = hasSuccessfulAppLaunch(events, requestedApp);
      for (const event of events) {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          if (event.message.stopReason === "error") {
            failure = typeof event.message.errorMessage === "string"
              ? event.message.errorMessage
              : "Pi could not complete the request. Check the configured model and Pi logs.";
          }
          text = extractText(event.message.content);
        }
      }
      if (failure) throw new Error(failure);
      const volumeSetActionId = expectedVolumeLevel === undefined
        ? undefined
        : getSuccessfulVolumeSetCallId(events, expectedVolumeLevel);
      const browserTaskSucceeded = expectedBrowserTask
        ? hasSuccessfulBrowserTask(events, expectedBrowserTask)
        : false;
      const scrollActionId = expectedScroll ? getSuccessfulScroll(events, expectedScroll) : undefined;
      const closeAppActionId = expectedCloseApp ? getSuccessfulCloseApp(events, expectedCloseApp) : undefined;
      return {
        text: text.trim() || "Pi finished without a text response. See the Pi session for details.",
        computerUseSucceeded,
        volumeSetSucceeded: volumeSetActionId !== undefined,
        browserTaskSucceeded,
        scrollSucceeded: scrollActionId !== undefined,
        ...(scrollActionId ? { scrollActionId } : {}),
        closeAppSucceeded: closeAppActionId !== undefined,
        ...(closeAppActionId ? { closeAppActionId } : {}),
        ...(volumeSetActionId ? { volumeSetActionId } : {}),
        cancelled: wasCancelledBeforeAction(events, requestedApp, expectedVolumeLevel, expectedBrowserTask, expectedScroll, expectedCloseApp),
      };
    } catch (error) {
      this.ready = false;
      this.extensionCommands = [];
      const message = error instanceof Error ? error.message : "Pi RPC request failed.";
      const failedClient = this.client;
      this.client = undefined;
      await failedClient?.stop().catch(() => undefined);
      this.failureReason = message;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async cancelCurrentTask(): Promise<boolean> {
    if (!this.busy || !this.client) return false;
    await this.client.abort();
    return true;
  }

  async stop() {
    this.ready = false;
    const client = this.client;
    this.client = undefined;
    await client?.stop();
    this.extensionCommands = [];
  }
}

export function getDesktopToolsStatus(
  rpcReady: boolean,
  hasExtension: boolean,
  commands: Array<{ name: string }>,
): ProviderStatus {
  if (!hasExtension) return "unavailable";
  if (!rpcReady) return "initializing";
  if (commands.some((command) => command.name === "computer-use-tools")) return "available";
  return "misconfigured";
}

export function hasSuccessfulNotepadLaunch(events: PiRpcEvent[]): boolean {
  return hasSuccessfulAppLaunch(events, "Notepad");
}

export function hasSuccessfulAppLaunch(events: PiRpcEvent[], expectedApp: string): boolean {
  const toolCalls = new Map<string, { toolName: string; args: unknown }>();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
      toolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end" && event.toolCallId) {
      const call = toolCalls.get(event.toolCallId);
      toolCalls.delete(event.toolCallId);
      if (event.isError === false && call && isLaunchOf(call.toolName, call.args, expectedApp)) return true;
    }
  }
  return false;
}

export function wasCancelledBeforeAction(events: PiRpcEvent[], expectedApp = "Notepad", expectedVolumeLevel?: number, expectedBrowserTask?: RequestedBrowserTask, expectedScroll?: RequestedScroll, expectedCloseApp?: string): boolean {
  const actionSucceeded = expectedVolumeLevel !== undefined
    ? hasSuccessfulVolumeSet(events, expectedVolumeLevel)
    : expectedBrowserTask
      ? hasSuccessfulBrowserTask(events, expectedBrowserTask)
      : expectedScroll
        ? getSuccessfulScroll(events, expectedScroll) !== undefined
        : expectedCloseApp
          ? getSuccessfulCloseApp(events, expectedCloseApp) !== undefined
          : hasSuccessfulAppLaunch(events, expectedApp);
  return events.some((event) => event.type === "agent_settled" && event.aborted) && !actionSucceeded;
}

export function getSuccessfulCloseApp(events: PiRpcEvent[], expectedApp: string): string | undefined {
  const toolCalls = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName === "voicepilot_close_app") {
      toolCalls.set(event.toolCallId, event.args);
    } else if (event.type === "tool_execution_end" && event.toolCallId && toolCalls.has(event.toolCallId)) {
      const args = toolCalls.get(event.toolCallId) as Record<string, unknown> | undefined;
      toolCalls.delete(event.toolCallId);
      if (event.isError === false && typeof args?.app_name === "string" && appTargetsMatch(expectedApp, args.app_name)) {
        return event.toolCallId;
      }
    }
  }
  return undefined;
}

export function getSuccessfulScroll(events: PiRpcEvent[], expected: RequestedScroll): string | undefined {
  const toolCalls = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName === "computer_use_scroll") {
      toolCalls.set(event.toolCallId, event.args);
    } else if (event.type === "tool_execution_end" && event.toolCallId && toolCalls.has(event.toolCallId)) {
      const args = toolCalls.get(event.toolCallId) as Record<string, unknown> | undefined;
      toolCalls.delete(event.toolCallId);
      if (event.isError === false && args?.direction === expected.direction && args.by === expected.by && args.amount === expected.amount) {
        return event.toolCallId;
      }
    }
  }
  return undefined;
}

export function hasSuccessfulBrowserTask(events: PiRpcEvent[], expected: RequestedBrowserTask): boolean {
  const toolCalls = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName === "voicepilot_browser_task") {
      const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
      if (args.goal === expected.goal && args.start_url === expected.startUrl) toolCalls.set(event.toolCallId, args);
    } else if (event.type === "tool_execution_end" && event.toolCallId && toolCalls.has(event.toolCallId)) {
      toolCalls.delete(event.toolCallId);
      if (event.isError === false) return true;
    }
  }
  return false;
}

export function hasSuccessfulVolumeSet(events: PiRpcEvent[], expectedLevel: number): boolean {
  return getSuccessfulVolumeSetCallId(events, expectedLevel) !== undefined;
}

export function getSuccessfulVolumeSetCallId(events: PiRpcEvent[], expectedLevel: number): string | undefined {
  const toolCalls = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName === "voicepilot_set_volume") {
      toolCalls.set(event.toolCallId, event.args && typeof event.args === "object"
        ? (event.args as Record<string, unknown>).level
        : undefined);
    } else if (event.type === "tool_execution_end" && event.toolCallId && toolCalls.has(event.toolCallId)) {
      const level = toolCalls.get(event.toolCallId);
      toolCalls.delete(event.toolCallId);
      if (event.isError === false && level === expectedLevel) return event.toolCallId;
    }
  }
  return undefined;
}

function isLaunchOf(toolName: string, args: unknown, expectedApp: string): boolean {
  if (toolName !== "computer_use_launch_app" || !args || typeof args !== "object") return false;
  const values = Object.entries(args as Record<string, unknown>)
    .filter(([key]) => ["name", "app", "application", "executable", "app_id", "appid", "bundle_id", "bundleid"].includes(key.toLowerCase()))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string");
  return values.length > 0 && values.every((value) => appTargetsMatch(expectedApp, value));
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is JsonRecord => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}
