import { Type } from "typebox";

export function createBrowserTool({ fetcher = globalThis.fetch, environment = process.env } = {}) {
  return {
    name: "voicepilot_browser_task",
    label: "Browse the web",
    description: "Run the user's currently authorized browser task through the local Laya worker. Only use the exact goal and URL from the current VoicePilot request. This first browser slice supports searching, navigation, and opening pages; it does not support form entry.",
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 2000 }),
      start_url: Type.String({ minLength: 8, maxLength: 2000 }),
    }),
    async execute(actionId, input, signal) {
      if (typeof actionId !== "string" || !actionId || typeof input?.goal !== "string" || typeof input?.start_url !== "string") {
        return toolError("VoicePilot received an invalid browser task request.");
      }
      if (typeof environment.VOICEPILOT_APPROVAL_TOKEN !== "string" || environment.VOICEPILOT_APPROVAL_TOKEN.length < 32) {
        return toolError("VoicePilot could not authorize this browser task.");
      }
      const bridgeUrl = (environment.VOICEPILOT_APPROVAL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
      const options = {
        method: "POST",
        headers: {
          authorization: `Bearer ${environment.VOICEPILOT_APPROVAL_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ actionId, goal: input.goal, start_url: input.start_url }),
        signal,
      };
      try {
        const authorizationResponse = await fetcher(`${bridgeUrl}/api/internal/browser/authorize`, options);
        const authorization = await readJson(authorizationResponse);
        if (!authorizationResponse.ok || authorization.authorized !== true) {
          return toolError(authorization.message ?? "VoicePilot rejected this browser task.");
        }
        const response = await fetcher(`${bridgeUrl}/api/internal/browser/execute`, options);
        const result = await readJson(response);
        if (!response.ok || result.solved !== true) {
          return toolError(result.error ?? `The browser task did not complete: ${result.stopped ?? "no verified completion"}.`);
        }
        return {
          content: [{ type: "text", text: `Browser task completed. ${JSON.stringify(result.summary ?? {})}` }],
          details: { solved: true, goal: input.goal, start_url: input.start_url, steps: result.steps ?? [] },
        };
      } catch (error) {
        const message = error instanceof Error && error.name === "AbortError"
          ? "The browser task was cancelled."
          : error instanceof Error ? error.message : "The Laya browser task failed.";
        return toolError(message);
      }
    },
  };
}

export default function voicePilotBrowserExtension(pi) {
  pi.registerTool(createBrowserTool());
  pi.registerCommand("voicepilot-browser", {
    description: "Reports that VoicePilot's browser task tool is registered.",
    handler: (_args, context) => context.ui.notify("VoicePilot browser task tool is registered.", "info"),
  });
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

async function readJson(response) {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
