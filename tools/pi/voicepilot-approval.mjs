import { Type } from "typebox";

const LAUNCH_TOOL = "computer_use_launch_app";
const SCROLL_TOOL = "computer_use_scroll";
const SAFE_TOOLS = new Set([
  "computer_use_check_permissions",
  "computer_use_connect",
  "computer_use_get_window_state",
  "computer_use_list_apps",
  "computer_use_list_windows",
  "computer_use_tools",
  "computer_use_verify_state",
]);
const TARGET_KEYS = new Set(["name", "app", "application", "executable", "app_id", "appid", "bundle_id", "bundleid", "aumid", "target"]);
const ALLOWED_EXTRA_KEYS = new Set(["session", "creates_new_application_instance", "start_minimized"]);

export function extractLaunchAppTarget(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const values = [];
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = key.toLowerCase();
    if (TARGET_KEYS.has(normalizedKey)) {
      if (typeof value !== "string" || !value.trim()) return undefined;
      values.push(value.trim());
    } else if (ALLOWED_EXTRA_KEYS.has(normalizedKey)) {
      if (normalizedKey === "creates_new_application_instance" && value !== false) return undefined;
      if (normalizedKey === "start_minimized" && value !== false) return undefined;
      if (normalizedKey === "session" && typeof value !== "string") return undefined;
    } else {
      return undefined;
    }
  }
  if (values.length === 0) return undefined;
  const normalized = values.map(normalizeAppTarget);
  if (normalized.some((value) => !value || value !== normalized[0])) return undefined;
  const primaryTarget = values[0];
  if (!/^[a-z0-9][a-z0-9 _+().!_-]{0,95}$/i.test(primaryTarget) || primaryTarget.includes("..")) return undefined;
  return primaryTarget;
}

export function normalizeAppTarget(value) {
  let target = value.trim();
  if (target.includes("!")) target = target.split("!", 1)[0];
  target = target.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  const parts = target.split(/[._]/).filter((part) => part && !/^[a-z0-9]{12,}$/.test(part));
  let leaf = (parts.at(-1) ?? target).trim();
  if (/^windows(?=[A-Z])/i.test(leaf)) leaf = leaf.slice("windows".length);
  return leaf.replace(/\s+/g, " ").toLowerCase();
}

export function extractScrollInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const allowedKeys = new Set(["pid", "direction", "by", "amount", "scope", "delivery_mode", "session"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return undefined;
  if (!Number.isInteger(input.pid) || input.pid < 1 || input.pid > 2_147_483_647) return undefined;
  if (input.direction !== "up" && input.direction !== "down") return undefined;
  if (input.by !== "line" && input.by !== "page") return undefined;
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 5) return undefined;
  if (input.scope !== undefined && input.scope !== "window") return undefined;
  if (input.delivery_mode !== undefined && input.delivery_mode !== "background") return undefined;
  if (input.session !== undefined && (typeof input.session !== "string" || input.session.length > 64)) return undefined;
  return { direction: input.direction, by: input.by, amount: input.amount };
}

export function createApprovalGate({
  fetcher = globalThis.fetch,
  environment = process.env,
  wait = delay,
  now = Date.now,
} = {}) {
  return async (event, context) => {
    if (!event.toolName.startsWith("computer_use_")) return;
    if (SAFE_TOOLS.has(event.toolName)) return;
    if (event.toolName === SCROLL_TOOL) {
      const scroll = extractScrollInput(event.input);
      const token = environment.VOICEPILOT_APPROVAL_TOKEN;
      const bridgeUrl = (environment.VOICEPILOT_APPROVAL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
      if (!scroll || typeof token !== "string" || token.length < 32 || typeof fetcher !== "function") {
        return blocked("VoicePilot could not validate this scroll; the action was not run.");
      }
      try {
        const response = await fetcher(`${bridgeUrl}/api/internal/actions/authorize`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ actionId: event.toolCallId, action: "scroll", ...scroll }),
          signal: context?.signal,
        });
        const authorization = await readJson(response);
        return response.ok && authorization.status === "authorized"
          ? undefined
          : blocked(authorization.message ?? "VoicePilot rejected this scroll request.");
      } catch {
        return blocked("VoicePilot could not authorize this scroll; the action was not run.");
      }
    }
    if (event.toolName !== LAUNCH_TOOL) {
      return blocked("This VoicePilot build supports only the requested app launch, volume change, browser task, or bounded scroll.");
    }

    const targetLabel = extractLaunchAppTarget(event.input);
    const token = environment.VOICEPILOT_APPROVAL_TOKEN;
    const bridgeUrl = (environment.VOICEPILOT_APPROVAL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    if (!targetLabel || typeof token !== "string" || token.length < 32 || typeof fetcher !== "function") {
      return blocked("VoicePilot could not validate this application launch; the action was not run.");
    }

    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const signal = context?.signal;
    try {
      const response = await fetcher(`${bridgeUrl}/api/internal/actions/authorize`, {
        method: "POST",
        headers,
        body: JSON.stringify({ actionId: event.toolCallId, action: "launch_app", targetLabel }),
        signal,
      });
      const authorization = await readJson(response);
      if (!response.ok) return blocked(authorization.message ?? "VoicePilot rejected this application launch.");
      if (authorization.status === "authorized") return;
      if (authorization.status !== "pending" || !authorization.approval?.approvalId) {
        return blocked("VoicePilot did not issue a valid approval for this application launch.");
      }

      const approval = authorization.approval;
      while (now() < Date.parse(approval.expiresAt)) {
        await wait(300, signal);
        const statusResponse = await fetcher(`${bridgeUrl}/api/internal/approvals/${encodeURIComponent(approval.approvalId)}`, {
          headers,
          signal,
        });
        const current = await readJson(statusResponse);
        if (!statusResponse.ok) return blocked(current.message ?? "The approval request is no longer available.");
        if (current.approval?.status === "approved") {
          const consumeResponse = await fetcher(`${bridgeUrl}/api/internal/approvals/${encodeURIComponent(approval.approvalId)}/consume`, {
            method: "POST",
            headers,
            signal,
          });
          const consumed = await readJson(consumeResponse);
          return consumeResponse.ok && consumed.consumed === true
            ? undefined
            : blocked("This approval was already used or is no longer valid.");
        }
        if (["rejected", "expired", "cancelled"].includes(current.approval?.status)) {
          return blocked(current.approval.status === "rejected"
            ? "The user declined this application launch."
            : current.approval.status === "expired"
              ? "The application launch approval expired."
              : "The task was cancelled before approval.");
        }
      }
      return blocked("The application launch approval expired.");
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "The task was cancelled before the application launch."
        : "VoicePilot could not confirm approval; the application was not launched.";
      return blocked(message);
    }
  };
}

export function createVolumeTool({ fetcher = globalThis.fetch, environment = process.env } = {}) {
  return {
    name: "voicepilot_set_volume",
    label: "Set system volume",
    description: "Set the Windows master output volume to one exact percentage and verify it. Use only for a direct user request with a numeric level from 0 to 100.",
    parameters: Type.Object({
      level: Type.Integer({ minimum: 0, maximum: 100, description: "Requested Windows master output volume percentage." }),
    }),
    async execute(actionId, input, signal) {
      if (!Number.isInteger(input?.level) || input.level < 0 || input.level > 100) {
        return toolError("Volume level must be an integer between 0 and 100.");
      }
      const token = environment.VOICEPILOT_APPROVAL_TOKEN;
      const bridgeUrl = (environment.VOICEPILOT_APPROVAL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
      if (typeof token !== "string" || token.length < 32 || typeof fetcher !== "function" || typeof actionId !== "string" || !actionId) {
        return toolError("VoicePilot could not authorize this volume action.");
      }
      try {
        const response = await fetcher(`${bridgeUrl}/api/internal/volume/set`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ actionId, level: input.level }),
          signal,
        });
        const result = await readJson(response);
        if (!response.ok || result.verified !== true || typeof result.level !== "number") {
          return toolError(result.message ?? "Windows volume could not be verified.");
        }
        return {
          content: [{ type: "text", text: `Windows master volume is verified at ${result.level}%.` }],
          details: { level: result.level, verified: true },
        };
      } catch (error) {
        const message = error instanceof Error && error.name === "AbortError"
          ? "The volume action was cancelled."
          : "VoicePilot could not reach the local volume service.";
        return toolError(message);
      }
    },
  };
}

export default function voicePilotApprovalExtension(pi) {
  pi.on("tool_call", createApprovalGate());
  pi.registerTool(createVolumeTool());
  pi.registerCommand("voicepilot-approval", {
    description: "Shows that VoicePilot's approval gate is active for desktop actions.",
    handler: (_args, context) => context.ui.notify("VoicePilot approval gate is active.", "info"),
  });
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

function blocked(reason) {
  return { block: true, terminate: true, reason };
}

async function readJson(response) {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
