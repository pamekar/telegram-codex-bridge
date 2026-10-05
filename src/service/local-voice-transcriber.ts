import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalVoiceConfig } from "../config.js";

const runPython = promisify(execFile);
// Arguments are passed directly to Python, never through a shell. PyAV decodes
// Telegram OGG/Opus files; no cloud API or Codex audio model is involved.
const TRANSCRIBE_SCRIPT = `
import json, sys
from faster_whisper import WhisperModel
model = WhisperModel(sys.argv[2], device="cpu", compute_type="int8", cpu_threads=4)
segments, _ = model.transcribe(sys.argv[1], language=sys.argv[3] or None, beam_size=5, vad_filter=True)
print(json.dumps({"text": " ".join(segment.text.strip() for segment in segments).strip()}))
`;

export async function transcribeLocalVoice(
  audioPath: string,
  config: LocalVoiceConfig,
  run: (bin: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: "utf8"; killSignal: "SIGKILL" }) => Promise<{ stdout: string }> = runPython
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await run(config.voiceWhisperPythonBin || "python3", [
      "-c", TRANSCRIBE_SCRIPT, audioPath, config.voiceWhisperModel || "small", config.voiceWhisperLanguage || ""
    ], { timeout: 180_000, maxBuffer: 1024 * 1024, encoding: "utf8", killSignal: "SIGKILL" }));
  } catch (error) {
    const failure = error as { killed?: boolean; code?: string | number };
    throw new Error(failure.killed
      ? "faster-whisper exceeded the 180-second transcription timeout"
      : `faster-whisper could not run (${failure.code ?? "unknown error"}). Check VOICE_WHISPER_PYTHON_BIN and the local model installation.`, { cause: error });
  }
  let result: unknown;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new Error("faster-whisper returned invalid transcription output");
  }
  const text = result && typeof result === "object" && "text" in result ? result.text : null;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("No speech was detected in the voice message");
  }
  return text.trim();
}
