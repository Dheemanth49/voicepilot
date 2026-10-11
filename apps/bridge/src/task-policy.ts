const BLOCKED_APP_TARGETS = new Set(["cmd", "command prompt", "powershell", "pwsh", "windows terminal"]);
const EXTRA_ACTION_WORDS = /\b(?:and|then|type|click|close|press|search|navigate|delete|send|submit)\b/i;

/** Accept one simple app-launch intent; the Pi tool gate approves every target except Notepad. */
export function getRequestedAppName(text: string): string | undefined {
  return parseRequestedAppName(text, "open");
}

export function getRequestedCloseApp(text: string): string | undefined {
  return parseRequestedAppName(text, "close");
}

export interface RequestedFileSearch {
  query: string;
  allowOpen: boolean;
}

/** Accept one explicit file search and remember whether the user asked to open a result. */
export function getRequestedFileSearch(text: string): RequestedFileSearch | undefined {
  const match = text.trim().match(/^(?:(?:please|could you|hey|hi)\s+)?(?:file\s+search(?:\s+for)?|find|search(?:\s+for)?|look for)(?: and open)?\s+(?:my\s+|the\s+)?(files?|documents?|notes?|code|source code|resumes?|résumés?|cv|spreadsheets?|presentations?|photos?|images?|pdfs?|invoices?|receipts?|reports?)\b(?:\s+(?:about|for|containing|on)\s+(.+?))?[.!?]*$/i);
  if (!match) return undefined;
  const category = match[1].trim();
  const genericCategory = /^(?:files?|documents?|notes?|code|source code)$/i.test(category);
  const query = (match[2] ?? (genericCategory ? text.trim() : category)).trim().replace(/\s+and open(?: the (?:file|document|result))?$/i, "").replace(/[.!?]+$/, "");
  if (!query || query.length > 1000 || /\bthen\b|\band\s+(?:close|delete|send|email|click|type|launch|run|browse|open)\b/i.test(query)) return undefined;
  return { query, allowOpen: /\bopen\b/i.test(text) };
}

function parseRequestedAppName(text: string, verb: "open" | "close"): string | undefined {
  const match = text.trim().match(new RegExp(`^(?:(?:please|could you)\\s+)?${verb}\\s+([a-z0-9][a-z0-9 _+().-]{0,47})[.!?]*$`, "i"));
  if (!match) return undefined;
  let appName = match[1].trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  appName = appName.replace(/^the\s+/i, "");
  if (/^windows\s+notepad$/i.test(appName)) appName = "Notepad";
  if (!appName || appName.includes("..") || looksLikeBareWebAddress(appName) || EXTRA_ACTION_WORDS.test(appName) || BLOCKED_APP_TARGETS.has(appName.toLowerCase())) return undefined;
  if (["all", "everything", "all apps", "all windows"].includes(appName.toLowerCase())) return undefined;
  return appName;
}

export function isAllowedFirstMilestone(text: string): boolean {
  return getRequestedAppName(text) !== undefined;
}

/** Accept one explicit request to set the Windows master output volume. */
export function getRequestedVolumeLevel(text: string): number | undefined {
  const match = text.trim().match(/^(?:(?:please|could you)\s+)?(?:set|reduce|lower)\s+(?:(?:my|the|computer|system)\s+)*volume(?:\s+level)?\s+to\s+(\d{1,3})\s*(?:%|percent)[.!?]*$/i);
  if (!match) return undefined;
  const level = Number(match[1]);
  return Number.isInteger(level) && level >= 0 && level <= 100 ? level : undefined;
}

/** Accept only explicit, idempotent mute/unmute instructions. */
export function getRequestedMute(text: string): boolean | undefined {
  const match = text.trim().match(/^(?:(?:please|could you)\s+)?(mute|unmute)\s+(?:(?:my|the|system|computer)\s+)*(?:audio|sound|volume|speakers?)(?:\s+(?:output|device))?[.!?]*$/i);
  if (!match) return undefined;
  return match[1].toLowerCase() === "mute";
}

export interface RequestedBrowserTask {
  goal: string;
  startUrl: string;
}

export interface RequestedScroll {
  direction: "up" | "down";
  by: "line" | "page";
  amount: number;
}

/** Accept one small, explicit vertical scroll and bound its size. */
export function getRequestedScroll(text: string): RequestedScroll | undefined {
  const match = text.trim().match(/^(?:(?:please|could you)\s+)?scroll\s+(up|down)(?:\s+(?:(\d{1,2})\s+(lines?|pages?)|a little))?[.!?]*$/i);
  if (!match) return undefined;
  const by = match[3]?.toLowerCase().startsWith("page") ? "page" : "line";
  const amount = match[2] ? Number(match[2]) : by === "page" ? 1 : 3;
  if (!Number.isInteger(amount) || amount < 1 || amount > 5) return undefined;
  return { direction: match[1].toLowerCase() as "up" | "down", by, amount };
}

/** Route only explicit browser requests with a concrete search or destination. */
export function getRequestedBrowserTask(text: string): RequestedBrowserTask | undefined {
  const trimmed = text.trim();
  const siteSearch = trimmed.match(/^(?:(?:please|could you)\s+)?(?:open|visit|browse to)\s+(?:the\s+)?((?:www\.)?google\.[a-z]{2,}(?:\.[a-z]{2,})?)(?:\s+(?:website|web\s+site|site))?\s+(?:and|then)\s+(?:search|google)\s+(?:for\s+)?(.+?)[.!?]*$/i);
  if (siteSearch) {
    const host = siteSearch[1].toLowerCase().replace(/^www\./, "");
    const query = siteSearch[2].trim();
    if (!query || query.length > 500) return undefined;
    return {
      goal: `Confirm that ${host} has opened.`,
      startUrl: `https://${host}/search?q=${encodeURIComponent(query)}`,
    };
  }

  const search = trimmed.match(/^(?:(?:please|could you)\s+)?(?:search (?:the web|google|youtube) for|google)\s+(.+?)[.!?]*$/i);
  if (search) {
    const query = search[1].trim();
    if (!query || query.length > 500) return undefined;
    const host = /youtube/i.test(search[0].slice(0, search[0].indexOf(query)))
      ? "https://www.youtube.com/results?search_query="
      : "https://www.google.com/search?q=";
    return { goal: `Find and open a useful result for: ${query}`, startUrl: `${host}${encodeURIComponent(query)}` };
  }

  const visit = trimmed.match(/^(?:(?:please|could you)\s+)?(?:browse to|visit|open)\s+(?:the\s+)?(https?:\/\/[^\s]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s]*)?)[.,!?;:]*?(?:\s+(.+))?$/i);
  if (!visit) return undefined;
  const suppliedUrl = visit[1].replace(/[.,!?;:]+$/, "");
  const rawUrl = /^https?:\/\//i.test(suppliedUrl) ? suppliedUrl : `https://${suppliedUrl}`;
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return undefined; }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return undefined;
  const trailingText = visit[2]?.trim().replace(/[.!?]+$/, "");
  const requestedGoal = trailingText && !/^(?:website|web site|site|webpage|web page)$/i.test(trailingText)
    ? trailingText
    : undefined;
  return {
    startUrl: parsed.toString(),
    goal: requestedGoal || `Confirm that ${parsed.hostname} has opened.`,
  };
}

function looksLikeBareWebAddress(value: string): boolean {
  if (/\.(?:exe|msi|bat|cmd|ps1|appx)$/i.test(value)) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:\/.*)?$/i.test(value);
}

export function normalizeAppTarget(value: string): string {
  let target = value.trim();
  if (target.includes("!")) target = target.split("!", 1)[0];
  target = target.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  if (/^windows\s+notepad$/i.test(target)) target = "Notepad";
  const parts = target.split(/[._]/).filter((part) => part && !/^[a-z0-9]{12,}$/.test(part));
  let leaf = (parts.at(-1) ?? target).trim();
  if (/^windows(?=[A-Z])/i.test(leaf)) leaf = leaf.slice("windows".length);
  return leaf.replace(/\s+/g, " ").toLowerCase();
}

export function appTargetsMatch(requested: string, supplied: string): boolean {
  const requestedName = normalizeAppTarget(requested);
  const suppliedName = normalizeAppTarget(supplied);
  return requestedName.length > 0 && requestedName === suppliedName;
}

export type AppLaunchAuthorization =
  | { allowed: true; requestedApp: string; requiresApproval: boolean }
  | { allowed: false; reason: "unsupported_request" | "target_mismatch" };

export function authorizeAppLaunch(taskText: string, suppliedTarget: string): AppLaunchAuthorization {
  const requestedApp = getRequestedAppName(taskText);
  if (!requestedApp) return { allowed: false, reason: "unsupported_request" };
  if (!appTargetsMatch(requestedApp, suppliedTarget)) return { allowed: false, reason: "target_mismatch" };
  return { allowed: true, requestedApp, requiresApproval: !appTargetsMatch("Notepad", requestedApp) };
}
