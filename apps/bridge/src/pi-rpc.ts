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
  onEvent?(listener: (event: PiRpcEvent) => void): () => void;
  getState(): Promise<unknown>;
  getCommands(): Promise<Array<{ name: string; description?: string }>>;
  getAvailableModels(): Promise<Array<{ provider: string; id: string }>>;
  setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }>;
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
  muteSetSucceeded: boolean;
  muteActionId?: string;
  browserTaskSucceeded: boolean;
  scrollSucceeded: boolean;
  scrollActionId?: string;
  closeAppSucceeded: boolean;
  closeAppActionId?: string;
  volumeSetActionId?: string;
  cancelled: boolean;
}

export interface PiNoToolResult {
  text: string;
  usedTools: boolean;
}

const START_TIMEOUT_MS = 15_000;
const TASK_TIMEOUT_MS = 180_000;
const LOCAL_MODEL_PROBE_TIMEOUT_MS = 1_500;

function readAssistantResponse(events: PiRpcEvent[]) {
  let text = "";
  let failure: string | undefined;
  for (const event of events) {
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    if (event.message.stopReason === "error") {
      failure = typeof event.message.errorMessage === "string"
        ? event.message.errorMessage
        : "Pi could not complete the request. Check the configured model and Pi logs.";
    }
    text = extractText(event.message.content);
  }
  return { text, failure, usedTools: events.some((event) => event.type === "tool_execution_start") };
}

async function probeLocalModel(baseUrl: string, modelId: string): Promise<boolean> {
  let modelsUrl: URL;
  try {
    modelsUrl = new URL(baseUrl);
    modelsUrl.pathname = `${modelsUrl.pathname.replace(/\/$/, "")}/models`;
    modelsUrl.search = "";
  } catch {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_MODEL_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(modelsUrl, { signal: controller.signal });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) return false;
    return (payload as { data: unknown[] }).data.some((model) =>
      !!model && typeof model === "object" && (model as { id?: unknown }).id === modelId);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class PiRpcClient {
  private client: PiRpcClientInstance | undefined;
  private removeEventListener: (() => void) | undefined;
  private toolEventHandler: ((event: PiRpcEvent) => void) | undefined;
  private starting: Promise<void> | undefined;
  private busy = false;
  private toolStartedDuringPrompt = false;
  private ready = false;
  private extensionCommands: Array<{ name: string; description?: string }> = [];
  failureReason: string | undefined;
  activeLlm: {
    provider: string;
    model: string;
    fallbackReason: string | null;
    fallbackModel?: { provider: string; id: string };
  } | undefined;

  constructor(private readonly projectRoot: string, private readonly envOverrides: NodeJS.ProcessEnv = {}) {}

  setToolEventHandler(handler: (event: PiRpcEvent) => void) {
    this.toolEventHandler = handler;
  }

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
      const piEnvironment: NodeJS.ProcessEnv = { ...process.env, ...this.envOverrides, PI_SKIP_VERSION_CHECK: "1" };
      // KiloCode is the configured online fallback; PI_OFFLINE disables its model catalog refresh.
      delete piEnvironment.PI_OFFLINE;
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
        env: piEnvironment,
      });
      this.client = client;
      await client.start();
      this.removeEventListener = client.onEvent?.((event) => {
        if (event.type === "tool_execution_start") this.toolStartedDuringPrompt = true;
        if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          this.toolEventHandler?.(event);
        }
      });
      let startupTimer: NodeJS.Timeout | undefined;
      let startupData: { state: { model?: { provider?: string; id?: string } }; commands: Array<{ name: string; description?: string }> };
      try {
        startupData = await Promise.race([
          Promise.all([client.getState(), client.getCommands()]).then(([state, commands]) => ({
            state: state as { model?: { provider?: string; id?: string } },
            commands,
          })),
          new Promise<never>((_, reject) => {
            startupTimer = setTimeout(() => reject(new Error("Pi RPC did not become ready within 15 seconds.")), START_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (startupTimer) clearTimeout(startupTimer);
      }
      this.extensionCommands = startupData.commands;
      const models = await client.getAvailableModels();
      const preferredProvider = (this.envOverrides.VOICEPILOT_LLM_PROVIDER ?? process.env.VOICEPILOT_LLM_PROVIDER ?? "local").trim().toLowerCase();
      const localProvider = (this.envOverrides.VOICEPILOT_LOCAL_LLM_PROVIDER ?? process.env.VOICEPILOT_LOCAL_LLM_PROVIDER ?? "ollama").trim().toLowerCase();
      const localModelId = (this.envOverrides.VOICEPILOT_LOCAL_LLM_MODEL ?? process.env.VOICEPILOT_LOCAL_LLM_MODEL ?? "").trim();
      const localBaseUrl = (this.envOverrides.VOICEPILOT_LOCAL_LLM_BASE_URL ?? process.env.VOICEPILOT_LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:11434/v1").trim();
      const kiloModelId = (this.envOverrides.VOICEPILOT_KILOCODE_MODEL ?? process.env.VOICEPILOT_KILOCODE_MODEL ?? "").trim();
      const localModels = models.filter((model) => model.provider.toLowerCase() === localProvider);
      const configuredLocal = localModels.find((model) => localModelId && model.id === localModelId) ?? (!localModelId ? localModels[0] : undefined);
      const selectedLocal = preferredProvider !== "kilocode" && configuredLocal && await probeLocalModel(localBaseUrl, configuredLocal.id) ? configuredLocal : undefined;
      const kiloModels = models.filter((model) => model.provider === "kilocode");
      const selectedKilo = kiloModelId
        ? kiloModels.find((model) => model.id === kiloModelId)
        : kiloModels.find((model) => model.provider === startupData.state.model?.provider && model.id === startupData.state.model?.id) ?? kiloModels[0];
      if (preferredProvider === "kilocode") {
        if (!selectedKilo) {
          throw new Error("KiloCode was selected as the primary LLM, but no KiloCode model is available. Sign in to KiloCode in Pi and check VOICEPILOT_KILOCODE_MODEL.");
        }
        await client.setModel(selectedKilo.provider, selectedKilo.id);
        this.activeLlm = { provider: selectedKilo.provider, model: selectedKilo.id, fallbackReason: null };
      } else if (selectedLocal) {
        await client.setModel(selectedLocal.provider, selectedLocal.id);
        this.activeLlm = {
          provider: selectedLocal.provider,
          model: selectedLocal.id,
          fallbackReason: null,
          ...(selectedKilo ? { fallbackModel: { provider: selectedKilo.provider, id: selectedKilo.id } } : {}),
        };
      } else if (selectedKilo) {
        const fallbackReason = localModelId && !configuredLocal
          ? `Local model ${localProvider}/${localModelId} is not available; using KiloCode.`
          : configuredLocal
            ? `Local inference server at ${localBaseUrl} is unavailable or does not list ${configuredLocal.id}; using KiloCode.`
            : `No available model was found for local provider “${localProvider}”; using KiloCode.`;
        await client.setModel(selectedKilo.provider, selectedKilo.id);
        this.activeLlm = { provider: selectedKilo.provider, model: selectedKilo.id, fallbackReason };
      } else {
        const localDescription = localModelId ? `${localProvider}/${localModelId}` : `provider “${localProvider}”`;
        throw new Error(`No local LLM is available (${localDescription}) and no KiloCode model is available. Configure the local model or sign in to KiloCode.`);
      }
      this.failureReason = undefined;
      this.ready = true;
    } catch (error) {
      this.ready = false;
      this.extensionCommands = [];
      this.activeLlm = undefined;
      this.removeEventListener?.();
      this.removeEventListener = undefined;
      await this.client?.stop().catch(() => undefined);
      this.client = undefined;
      this.failureReason = error instanceof Error ? error.message : "Pi RPC did not become ready.";
      throw new Error(this.failureReason);
    }
  }

  async prompt(prompt: string, expectedApp?: string, expectedVolumeLevel?: number, expectedBrowserTask?: RequestedBrowserTask, expectedScroll?: RequestedScroll, expectedCloseApp?: string, expectedMuteState?: boolean, expectedFileSearch = false): Promise<PiTaskResult> {
    if (!this.isReady) await this.start();
    if (this.busy) throw new Error("VoicePilot is already processing another task. Wait for it to finish before submitting another.");
    const client = this.client;
    if (!client) throw new Error("Pi RPC process is not running.");
    this.busy = true;
    try {
      this.toolStartedDuringPrompt = false;
      let events: PiRpcEvent[];
      try {
        events = await client.promptAndWait(prompt, undefined, TASK_TIMEOUT_MS);
      } catch (error) {
        const localModel = this.activeLlm;
        if (isEventCollectionTimeout(error) && !this.toolStartedDuringPrompt
          && localModel?.provider !== "kilocode" && localModel?.fallbackModel) {
          await client.abort().catch(() => undefined);
          const fallback = localModel.fallbackModel;
          await client.setModel(fallback.provider, fallback.id);
          this.activeLlm = {
            provider: fallback.provider,
            model: fallback.id,
            fallbackReason: `Local model ${localModel.provider}/${localModel.model} timed out before any tool action; retried with KiloCode.`,
          };
          this.toolStartedDuringPrompt = false;
          events = await client.promptAndWait(prompt, undefined, TASK_TIMEOUT_MS);
        } else {
          await client.abort().catch(() => undefined);
          throw error;
        }
      }

      let text = "";
      let failure: string | undefined;
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
      const localModel = this.activeLlm;
      const toolStarted = events.some((event) => event.type === "tool_execution_start");
      if (failure && localModel?.provider !== "kilocode" && localModel?.fallbackModel && !toolStarted) {
        const fallback = localModel.fallbackModel;
        await client.setModel(fallback.provider, fallback.id);
        this.activeLlm = {
          provider: fallback.provider,
          model: fallback.id,
          fallbackReason: `Local model ${localModel.provider}/${localModel.model} failed before any tool action; retried with KiloCode.`,
        };
        this.toolStartedDuringPrompt = false;
        events = await client.promptAndWait(prompt, undefined, TASK_TIMEOUT_MS);
        text = "";
        failure = undefined;
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
      }
      const requestedApp = expectedApp ?? getRequestedAppName(prompt) ?? "Notepad";
      const computerUseSucceeded = hasSuccessfulAppLaunch(events, requestedApp);
      if (failure) throw new Error(failure);
      const volumeSetActionId = expectedVolumeLevel === undefined
        ? undefined
        : getSuccessfulVolumeSetCallId(events, expectedVolumeLevel);
      const muteActionId = expectedMuteState === undefined
        ? undefined
        : getSuccessfulMuteSetCallId(events, expectedMuteState);
      const browserTaskSucceeded = expectedBrowserTask
        ? hasSuccessfulBrowserTask(events, expectedBrowserTask)
        : false;
      const scrollActionId = expectedScroll ? getSuccessfulScroll(events, expectedScroll) : undefined;
      const closeAppActionId = expectedCloseApp ? getSuccessfulCloseApp(events, expectedCloseApp) : undefined;
      return {
        text: text.trim() || "Pi finished without a text response. See the Pi session for details.",
        computerUseSucceeded,
        volumeSetSucceeded: volumeSetActionId !== undefined,
        muteSetSucceeded: muteActionId !== undefined,
        ...(muteActionId ? { muteActionId } : {}),
        browserTaskSucceeded,
        scrollSucceeded: scrollActionId !== undefined,
        ...(scrollActionId ? { scrollActionId } : {}),
        closeAppSucceeded: closeAppActionId !== undefined,
        ...(closeAppActionId ? { closeAppActionId } : {}),
        ...(volumeSetActionId ? { volumeSetActionId } : {}),
        cancelled: wasCancelledBeforeAction(events, requestedApp, expectedVolumeLevel, expectedBrowserTask, expectedScroll, expectedCloseApp, expectedMuteState, expectedFileSearch),
      };
    } catch (error) {
      this.ready = false;
      this.extensionCommands = [];
      this.activeLlm = undefined;
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

  /** Ask Pi to classify or answer conversationally; any attempted tool call invalidates the response. */
  async promptNoTools(prompt: string): Promise<PiNoToolResult> {
    if (!this.isReady) await this.start();
    if (this.busy) throw new Error("VoicePilot is already processing another task. Wait for it to finish before submitting another.");
    const client = this.client;
    if (!client) throw new Error("Pi RPC process is not running.");
    this.busy = true;
    try {
      this.toolStartedDuringPrompt = false;
      let events: PiRpcEvent[];
      try {
        events = await client.promptAndWait(prompt, undefined, TASK_TIMEOUT_MS);
      } catch (error) {
        const localModel = this.activeLlm;
        if (isEventCollectionTimeout(error) && !this.toolStartedDuringPrompt
          && localModel?.provider !== "kilocode" && localModel?.fallbackModel) {
          await client.abort().catch(() => undefined);
          const fallback = localModel.fallbackModel;
          await client.setModel(fallback.provider, fallback.id);
          this.activeLlm = {
            provider: fallback.provider,
            model: fallback.id,
            fallbackReason: `Local model ${localModel.provider}/${localModel.model} timed out before any tool action; retried with KiloCode.`,
          };
          this.toolStartedDuringPrompt = false;
          events = await client.promptAndWait(prompt, undefined, TASK_TIMEOUT_MS);
        } else {
          await client.abort().catch(() => undefined);
          throw error;
        }
      }
      let response = readAssistantResponse(events);
      const localModel = this.activeLlm;
      if (response.failure && localModel?.provider !== "kilocode" && localModel?.fallbackModel && !response.usedTools) {
        const fallback = localModel.fallbackModel;
        await client.setModel(fallback.provider, fallback.id);
        this.activeLlm = {
          provider: fallback.provider,
          model: fallback.id,
          fallbackReason: `Local model ${localModel.provider}/${localModel.model} failed before any tool action; retried with KiloCode.`,
        };
        this.toolStartedDuringPrompt = false;
        events = await client.promptAndWait(prompt, undefined, TASK_TIMEOUT_MS);
        response = readAssistantResponse(events);
      }
      if (response.failure) throw new Error(response.failure);
      if (response.usedTools) throw new Error("Pi attempted to use a tool during a no-tool response. The request was stopped before capability dispatch.");
      return { text: response.text.trim(), usedTools: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pi RPC request failed.";
      // A model attempting a tool during a chat-only turn is a rejected
      // response, not a broken Pi session. Keep integrations online so the
      // next request can still use them.
      if (/attempted to use a tool during a no-tool response/i.test(message)) {
        throw error;
      }
      const failedClient = this.client;
      this.ready = false;
      this.extensionCommands = [];
      this.activeLlm = undefined;
      this.removeEventListener?.();
      this.removeEventListener = undefined;
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
    this.removeEventListener?.();
    this.removeEventListener = undefined;
    const client = this.client;
    this.client = undefined;
    await client?.stop();
    this.extensionCommands = [];
    this.activeLlm = undefined;
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

export function wasCancelledBeforeAction(events: PiRpcEvent[], expectedApp = "Notepad", expectedVolumeLevel?: number, expectedBrowserTask?: RequestedBrowserTask, expectedScroll?: RequestedScroll, expectedCloseApp?: string, expectedMuteState?: boolean, expectedFileSearch = false): boolean {
  const actionSucceeded = expectedVolumeLevel !== undefined
    ? hasSuccessfulVolumeSet(events, expectedVolumeLevel)
    : expectedMuteState !== undefined
      ? getSuccessfulMuteSetCallId(events, expectedMuteState) !== undefined
    : expectedFileSearch
      ? hasSuccessfulFileSearch(events)
    : expectedBrowserTask
      ? hasSuccessfulBrowserTask(events, expectedBrowserTask)
      : expectedScroll
        ? getSuccessfulScroll(events, expectedScroll) !== undefined
        : expectedCloseApp
          ? getSuccessfulCloseApp(events, expectedCloseApp) !== undefined
          : hasSuccessfulAppLaunch(events, expectedApp);
  return events.some((event) => event.type === "agent_settled" && event.aborted) && !actionSucceeded;
}

function hasSuccessfulFileSearch(events: PiRpcEvent[]): boolean {
  const searches = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName === "voicepilot_search_files") {
      searches.add(event.toolCallId);
    } else if (event.type === "tool_execution_end" && event.toolCallId && searches.has(event.toolCallId)) {
      searches.delete(event.toolCallId);
      if (event.isError === false) return true;
    }
  }
  return false;
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

export function getSuccessfulMuteSetCallId(events: PiRpcEvent[], expectedMuted: boolean): string | undefined {
  const toolCalls = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName === "voicepilot_set_mute") {
      toolCalls.set(event.toolCallId, event.args && typeof event.args === "object"
        ? (event.args as Record<string, unknown>).muted
        : undefined);
    } else if (event.type === "tool_execution_end" && event.toolCallId && toolCalls.has(event.toolCallId)) {
      const muted = toolCalls.get(event.toolCallId);
      toolCalls.delete(event.toolCallId);
      if (event.isError === false && muted === expectedMuted) return event.toolCallId;
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

function isEventCollectionTimeout(error: unknown): boolean {
  return error instanceof Error && /timeout collecting events/i.test(error.message);
}
