import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SpeechTranscription } from "./stt-client.js";

const audioExtensions: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
};

export interface AudioUploadResponse {
  status: 200 | 400 | 415 | 503;
  body: Partial<SpeechTranscription> & { error?: { code: "INVALID_REQUEST" | "STT_UNAVAILABLE"; message: string } };
}

export async function transcribeAudioUpload(input: {
  contentType: string;
  body: AsyncIterable<Uint8Array | string>;
  enabled: boolean;
  disabledReason?: string;
  dataDirectory: string;
  transcribe: (audioPath: string) => Promise<string | SpeechTranscription>;
  maxBytes?: number;
}): Promise<AudioUploadResponse> {
  const contentType = input.contentType.split(";")[0].trim().toLowerCase();
  const extension = audioExtensions[contentType];
  if (!extension) return { status: 415, body: { error: { code: "INVALID_REQUEST", message: "Upload audio/webm, audio/ogg, audio/wav, audio/mpeg, or audio/mp4." } } };
  if (!input.enabled) return { status: 503, body: { error: { code: "STT_UNAVAILABLE", message: input.disabledReason ?? "Voice is disabled. Set up local speech recognition and enable it in .env." } } };

  const maxBytes = input.maxBytes ?? 25 * 1024 * 1024;
  const audioPath = join(input.dataDirectory, `recording.${randomUUID()}${extension}`);
  let audioFile: Awaited<ReturnType<typeof open>> | undefined;
  let size = 0;
  let tooLarge = false;
  try {
    await mkdir(input.dataDirectory, { recursive: true });
    audioFile = await open(audioPath, "w");
    for await (const chunk of input.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        tooLarge = true;
        continue;
      }
      await audioFile.writeFile(buffer);
    }
    if (tooLarge) return { status: 400, body: { error: { code: "INVALID_REQUEST", message: "Audio recording exceeds the 25 MB limit." } } };
    if (size === 0) return { status: 400, body: { error: { code: "INVALID_REQUEST", message: "Audio recording is empty." } } };
    await audioFile.close();
    audioFile = undefined;
    const transcription = await input.transcribe(audioPath);
    return { status: 200, body: typeof transcription === "string" ? { text: transcription } : transcription };
  } catch (error) {
    return { status: 503, body: { error: { code: "STT_UNAVAILABLE", message: error instanceof Error ? error.message : "Audio upload or transcription failed." } } };
  } finally {
    await audioFile?.close().catch(() => undefined);
    await unlink(audioPath).catch(() => undefined);
  }
}
