export type ProviderStatus =
  | "available"
  | "initializing"
  | "unavailable"
  | "misconfigured";

export interface FileSearchRuntimeStatus {
  device: "cpu" | "cuda";
  devicePreference: "auto" | "cpu" | "cuda";
  backend: "pytorch";
  dtype: "float32";
  fallbackReason: string | null;
}

export interface SttRuntimeStatus {
  device: "cpu" | "cuda";
  devicePreference: "auto" | "cpu" | "cuda";
  backend: "ctranslate2";
  fallbackReason: string | null;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  components: {
    pi: ProviderStatus;
    stt: ProviderStatus;
    hotkey: ProviderStatus;
    fileSearch: ProviderStatus;
    tts: ProviderStatus;
    layaRouter: ProviderStatus;
    browserTools: ProviderStatus;
    desktopTools: ProviderStatus;
  };
  providers?: { sttModel?: string; fileSearchModel?: string; llmProvider?: string; llmModel?: string; llmFallbackReason?: string | null; sttRuntime?: SttRuntimeStatus; fileSearchRuntime?: FileSearchRuntimeStatus };
  timestamp: string;
}

export interface ApiError {
  error: {
    code: "PI_UNAVAILABLE" | "INVALID_REQUEST" | "UNSUPPORTED_ACTION" | "TASK_FAILED" | "BUSY" | "TASK_NOT_CANCELLABLE" | "APPROVAL_NOT_PENDING" | "APPROVAL_EXPIRED" | "APPROVAL_NOT_FOUND";
    message: string;
  };
}

export interface TaskRequest {
  input: {
    type: "text" | "transcript";
    text: string;
  };
  source?: "ui" | "hotkey" | "api";
  options?: {
    allowCloudFallback?: boolean;
    speakResponse?: boolean;
  };
}

export interface TaskResponse {
  taskId: string;
  status: "executing" | "succeeded" | "partially_succeeded" | "failed" | "cancelled";
  mode?: "chat" | "browser" | "desktop" | "file_search";
  transcript: string;
  actionSteps?: TaskActionStep[];
  result?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface TaskActionStep {
  id: string;
  label: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
}

export type ApprovalDecision = "approve" | "reject";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export interface ApprovalRecord {
  approvalId: string;
  taskId: string;
  actionId: string;
  action: string;
  targetLabel: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  consumedAt?: string;
}

export type TaskEventType = "task.created" | "task.status" | "task.action" | "task.finished" | "approval.required" | "approval.resolved";

export interface TaskEvent {
  eventId: string;
  type: TaskEventType;
  taskId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

