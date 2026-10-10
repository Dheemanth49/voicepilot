import type { FileSearchRuntimeStatus, SttRuntimeStatus } from "../../../packages/contracts/src/index.js";

export function buildRuntimeStatus(input: {
  stt?: SttRuntimeStatus | null;
  fileSearch?: FileSearchRuntimeStatus | null;
}): { sttRuntime?: SttRuntimeStatus; fileSearchRuntime?: FileSearchRuntimeStatus } {
  return {
    ...(input.stt ? { sttRuntime: input.stt } : {}),
    ...(input.fileSearch ? { fileSearchRuntime: input.fileSearch } : {}),
  };
}
