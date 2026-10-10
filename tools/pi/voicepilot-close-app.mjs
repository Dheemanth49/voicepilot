import { Type } from "typebox";

export function createCloseAppTool({ callTool, authorize, wait = delay, environment = process.env } = {}) {
  return {
    name: "voicepilot_close_app",
    label: "Close app window",
    description: "Close one visible window belonging to the exact app named in the active VoicePilot request. Sends Alt+F4 to that selected window and verifies that its window ID disappears. Does not force-terminate the app.",
    parameters: Type.Object({ app_name: Type.String({ minLength: 1, maxLength: 64 }) }),
    async execute(actionId, input, signal) {
      const appName = typeof input?.app_name === "string" ? input.app_name.trim() : "";
      if (!/^[a-z0-9][a-z0-9 _+().-]{0,63}$/i.test(appName) || !/^[a-z0-9_-]{1,128}$/i.test(actionId ?? "")) {
        return toolError("VoicePilot received an invalid app close request.");
      }
      if (typeof environment.VOICEPILOT_APPROVAL_TOKEN !== "string" || environment.VOICEPILOT_APPROVAL_TOKEN.length < 32) {
        return toolError("VoicePilot could not authorize this app close request.");
      }
      try {
        const before = await readWindows(await callTool("list_windows", { on_screen_only: true }, signal));
        const selected = selectWindow(before, appName);
        if (!selected) return toolError(`No unambiguous visible ${appName} window was found.`);
        const authorization = await authorize({
          actionId,
          action: "close_app",
          targetLabel: appName,
          pid: selected.pid,
          windowId: selected.window_id,
        }, signal);
        if (!authorization?.ok) return toolError(authorization?.message ?? "VoicePilot rejected this app close request.");

        const closeResult = await callTool("hotkey", {
          pid: selected.pid,
          window_id: selected.window_id,
          keys: ["alt", "f4"],
          delivery_mode: "background",
        }, signal);
        if (closeResult?.isError) return toolError(readToolError(closeResult) ?? `Could not send the close shortcut to ${appName}.`);
        await wait(350, signal);
        const after = await readWindows(await callTool("list_windows", { on_screen_only: true }, signal));
        if (after.some((window) => window.pid === selected.pid && window.window_id === selected.window_id)) {
          return toolError(`The ${appName} window remains open; VoicePilot did not report it closed.`);
        }
        return {
          content: [{ type: "text", text: `The ${appName} window closed and was verified.` }],
          details: { closed: true, appName, pid: selected.pid, windowId: selected.window_id },
        };
      } catch (error) {
        const message = error instanceof Error && error.name === "AbortError"
          ? "The app close request was cancelled."
          : error instanceof Error ? error.message : `VoicePilot could not close ${appName}.`;
        return toolError(message);
      }
    },
  };
}

export function selectWindow(windows, appName) {
  if (!Array.isArray(windows)) return undefined;
  const wanted = normalizeAppName(appName);
  const matching = windows.filter((window) => window && (typeof window.app_name === "string" || typeof window.title === "string")
    && normalizeAppName(windowAppLabel(window)) === wanted
    && Number.isInteger(window.pid) && window.pid > 0
    && Number.isInteger(window.window_id) && window.window_id > 0
    && window.is_on_screen === true);
  if (matching.length === 0) return undefined;
  if (matching.length === 1) return matching[0];
  if (matching.some((window) => !Number.isInteger(window.z_index))) return undefined;
  matching.sort((left, right) => right.z_index - left.z_index);
  if (matching[0].z_index === matching[1].z_index) return undefined;
  return matching[0];
}

async function readWindows(result) {
  if (result?.isError) throw new Error(readToolError(result) ?? "The CUA driver could not list visible windows.");
  let windows = result?.structuredContent?.windows;
  if (!Array.isArray(windows)) {
    for (const item of result?.content ?? []) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed = JSON.parse(item.text);
        windows = Array.isArray(parsed) ? parsed : parsed.windows;
        if (Array.isArray(windows)) break;
      } catch { /* The text block is not the structured window list. */ }
    }
  }
  if (!Array.isArray(windows)) throw new Error("The CUA driver returned no structured window list.");
  return windows;
}

function normalizeAppName(value) {
  return value.trim().replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").replace(/\s+/g, " ").toLowerCase();
}

function windowAppLabel(window) {
  if (typeof window.app_name === "string" && window.app_name.trim()) return window.app_name;
  const title = typeof window.title === "string" ? window.title.trim() : "";
  const separator = title.lastIndexOf(" - ");
  return separator >= 0 ? title.slice(separator + 3) : title;
}

function readToolError(result) {
  return result?.content?.find((item) => item?.type === "text" && typeof item.text === "string")?.text;
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

function delay(milliseconds, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new DOMException("The operation was aborted.", "AbortError"));
    const timer = setTimeout(resolvePromise, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
}
