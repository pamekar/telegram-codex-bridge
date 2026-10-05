import { readFile, writeFile } from "node:fs/promises";
import { delimiter } from "node:path";

import {
  getBridgePackCatalogEntry,
  listSupportedBridgePacks,
  parseBridgePackName,
  type BridgePackOptionValue
} from "./packs/catalog.js";
import { DEFAULT_BRIDGE_PACK, type BridgePackName } from "./packs/names.js";
import { getHostPlatform } from "./platform.js";
import type { BridgePaths } from "./paths.js";
import { parseBooleanLike } from "./util/boolean.js";
import { expandHomePath, normalizeComparablePath } from "./util/path.js";

export interface LocalVoiceConfig {
  voiceTranscriptionProvider?: "auto" | "faster-whisper";
  voiceWhisperPythonBin?: string;
  voiceWhisperModel?: string;
  voiceWhisperLanguage?: string;
}

export interface SharedBridgeConfig extends LocalVoiceConfig {
  activePack: BridgePackName;
  codexBin: string;
  projectScanRoots: string[];
  voiceInputEnabled: boolean;
  voiceOpenaiApiKey: string;
  voiceOpenaiTranscribeModel: string;
  voiceFfmpegBin: string;
  perfMonitorEnabled: boolean;
  perfMonitorSampleIntervalMs: number;
  perfMonitorRetentionDays: number;
  appServerGuardEnabled?: boolean;
  appServerGuardSampleIntervalMs?: number;
  appServerGuardMcpWorkerThreshold?: number;
  appServerGuardConsecutiveWindows?: number;
  appServerGuardCooldownMs?: number;
}

export interface BridgeConfig extends LocalVoiceConfig {
  activePack: BridgePackName;
  shared: SharedBridgeConfig;
  packs: Partial<Record<BridgePackName, unknown>>;
  codexBin: string;
  projectScanRoots: string[];
  voiceInputEnabled: boolean;
  voiceOpenaiApiKey: string;
  voiceOpenaiTranscribeModel: string;
  voiceFfmpegBin: string;
  perfMonitorEnabled: boolean;
  perfMonitorSampleIntervalMs: number;
  perfMonitorRetentionDays: number;
  appServerGuardEnabled?: boolean;
  appServerGuardSampleIntervalMs?: number;
  appServerGuardMcpWorkerThreshold?: number;
  appServerGuardConsecutiveWindows?: number;
  appServerGuardCooldownMs?: number;
}

export interface BridgeInstallOverrides extends LocalVoiceConfig {
  activePack?: BridgePackName;
  codexBin?: string;
  projectScanRoots?: string[];
  voiceInputEnabled?: boolean;
  voiceOpenaiApiKey?: string;
  voiceOpenaiTranscribeModel?: string;
  voiceFfmpegBin?: string;
  perfMonitorEnabled?: boolean;
  perfMonitorSampleIntervalMs?: number;
  perfMonitorRetentionDays?: number;
  appServerGuardEnabled?: boolean;
  appServerGuardSampleIntervalMs?: number;
  appServerGuardMcpWorkerThreshold?: number;
  appServerGuardConsecutiveWindows?: number;
  appServerGuardCooldownMs?: number;
  packOptions?: Record<string, BridgePackOptionValue>;
}

const DEFAULT_SHARED_CONFIG = {
  activePack: DEFAULT_BRIDGE_PACK,
  codexBin: "codex",
  projectScanRoots: [],
  voiceInputEnabled: false,
  voiceOpenaiTranscribeModel: "gpt-4o-mini-transcribe",
  voiceFfmpegBin: "ffmpeg",
  perfMonitorEnabled: false,
  perfMonitorSampleIntervalMs: 15_000,
  perfMonitorRetentionDays: 7,
  appServerGuardEnabled: true,
  appServerGuardSampleIntervalMs: 30_000,
  appServerGuardMcpWorkerThreshold: 6,
  appServerGuardConsecutiveWindows: 3,
  appServerGuardCooldownMs: 900_000
} as const;

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return parseBooleanLike(value) ?? fallback;
}

function parseEnvFile(content: string): Record<string, string> {
  const entries = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator === -1) {
        return null;
      }

      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return Object.fromEntries(entries);
}

export function parseProjectScanRootsValue(value: string | undefined, homeDir: string): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const roots: string[] = [];
  const hostPlatform = getHostPlatform();

  for (const entry of value.split(delimiter).map((part) => part.trim()).filter((part) => part.length > 0)) {
    const resolved = expandHomePath(entry, homeDir);
    const comparable = normalizeComparablePath(resolved, hostPlatform);
    if (seen.has(comparable)) {
      continue;
    }

    seen.add(comparable);
    roots.push(resolved);
  }

  return roots;
}

export function serializeProjectScanRoots(roots: string[]): string {
  return roots.join(delimiter);
}

export function buildConfigEnvironment(config: BridgeConfig): Record<string, string> {
  const shared = config.shared;
  const env: Record<string, string> = {
    BRIDGE_PACK: config.activePack,
    CODEX_BIN: shared.codexBin,
    PROJECT_SCAN_ROOTS: serializeProjectScanRoots(shared.projectScanRoots),
    VOICE_INPUT_ENABLED: shared.voiceInputEnabled ? "1" : "0",
    VOICE_TRANSCRIPTION_PROVIDER: shared.voiceTranscriptionProvider ?? "auto",
    VOICE_WHISPER_PYTHON_BIN: shared.voiceWhisperPythonBin ?? "python3",
    VOICE_WHISPER_MODEL: shared.voiceWhisperModel ?? "small",
    VOICE_WHISPER_LANGUAGE: shared.voiceWhisperLanguage ?? "en",
    VOICE_OPENAI_API_KEY: shared.voiceOpenaiApiKey,
    VOICE_OPENAI_TRANSCRIBE_MODEL: shared.voiceOpenaiTranscribeModel,
    VOICE_FFMPEG_BIN: shared.voiceFfmpegBin,
    PERF_MONITOR_ENABLED: shared.perfMonitorEnabled ? "1" : "0",
    PERF_MONITOR_SAMPLE_INTERVAL_MS: `${shared.perfMonitorSampleIntervalMs}`,
    PERF_MONITOR_RETENTION_DAYS: `${shared.perfMonitorRetentionDays}`,
    APP_SERVER_GUARD_ENABLED: `${(shared.appServerGuardEnabled ?? DEFAULT_SHARED_CONFIG.appServerGuardEnabled) ? 1 : 0}`,
    APP_SERVER_GUARD_SAMPLE_INTERVAL_MS:
      `${shared.appServerGuardSampleIntervalMs ?? DEFAULT_SHARED_CONFIG.appServerGuardSampleIntervalMs}`,
    APP_SERVER_GUARD_MCP_WORKER_THRESHOLD:
      `${shared.appServerGuardMcpWorkerThreshold ?? DEFAULT_SHARED_CONFIG.appServerGuardMcpWorkerThreshold}`,
    APP_SERVER_GUARD_CONSECUTIVE_WINDOWS:
      `${shared.appServerGuardConsecutiveWindows ?? DEFAULT_SHARED_CONFIG.appServerGuardConsecutiveWindows}`,
    APP_SERVER_GUARD_COOLDOWN_MS:
      `${shared.appServerGuardCooldownMs ?? DEFAULT_SHARED_CONFIG.appServerGuardCooldownMs}`
  };

  for (const packName of listSupportedBridgePacks()) {
    const entry = getBridgePackCatalogEntry(packName);
    const packConfig = (config.packs[packName] ?? entry.configCodec.getDefaultConfig()) as never;
    Object.assign(env, entry.configCodec.writeToEnv(packConfig));
  }

  return env;
}

export function validateConfig(config: BridgeConfig): void {
  const errors: string[] = [];

  if (typeof config.codexBin !== "string" || config.codexBin.trim().length === 0) {
    errors.push("CODEX_BIN is required; set it in bridge.env or as an environment variable");
  }

  function checkPositiveInt(value: number, name: string, min: number): void {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
      errors.push(`${name} must be an integer >= ${min} (got: ${JSON.stringify(value)})`);
    }
  }

  checkPositiveInt(config.perfMonitorSampleIntervalMs, "PERF_MONITOR_SAMPLE_INTERVAL_MS", 100);
  checkPositiveInt(config.perfMonitorRetentionDays, "PERF_MONITOR_RETENTION_DAYS", 1);

  if (config.appServerGuardEnabled) {
    checkPositiveInt(
      config.appServerGuardSampleIntervalMs ?? 0,
      "APP_SERVER_GUARD_SAMPLE_INTERVAL_MS",
      1000
    );
    checkPositiveInt(
      config.appServerGuardMcpWorkerThreshold ?? 0,
      "APP_SERVER_GUARD_MCP_WORKER_THRESHOLD",
      1
    );
    checkPositiveInt(
      config.appServerGuardConsecutiveWindows ?? 0,
      "APP_SERVER_GUARD_CONSECUTIVE_WINDOWS",
      1
    );
    checkPositiveInt(
      config.appServerGuardCooldownMs ?? -1,
      "APP_SERVER_GUARD_COOLDOWN_MS",
      0
    );
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}

export async function loadConfig(paths: BridgePaths): Promise<BridgeConfig> {
  let envFile: Record<string, string> = {};

  try {
    envFile = parseEnvFile(await readFile(paths.envPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const merged = {
    ...process.env,
    ...envFile
  };

  const activePack = parseBridgePackName(merged.BRIDGE_PACK) ?? DEFAULT_SHARED_CONFIG.activePack;
  const projectScanRoots = parseProjectScanRootsValue(merged.PROJECT_SCAN_ROOTS, paths.homeDir);
  const voiceProvider = merged.VOICE_TRANSCRIPTION_PROVIDER ?? "auto";
  if (voiceProvider !== "auto" && voiceProvider !== "faster-whisper") {
    throw new Error("VOICE_TRANSCRIPTION_PROVIDER must be auto or faster-whisper");
  }
  const shared: SharedBridgeConfig = {
    voiceTranscriptionProvider: voiceProvider,
    voiceWhisperPythonBin: merged.VOICE_WHISPER_PYTHON_BIN || "python3",
    voiceWhisperModel: merged.VOICE_WHISPER_MODEL || "small",
    voiceWhisperLanguage: merged.VOICE_WHISPER_LANGUAGE ?? "en",
    activePack,
    codexBin: merged.CODEX_BIN ?? DEFAULT_SHARED_CONFIG.codexBin,
    projectScanRoots,
    voiceInputEnabled: parseBooleanEnv(merged.VOICE_INPUT_ENABLED, DEFAULT_SHARED_CONFIG.voiceInputEnabled),
    voiceOpenaiApiKey: merged.VOICE_OPENAI_API_KEY ?? "",
    voiceOpenaiTranscribeModel: merged.VOICE_OPENAI_TRANSCRIBE_MODEL ?? DEFAULT_SHARED_CONFIG.voiceOpenaiTranscribeModel,
    voiceFfmpegBin: merged.VOICE_FFMPEG_BIN ?? DEFAULT_SHARED_CONFIG.voiceFfmpegBin,
    perfMonitorEnabled: parseBooleanEnv(merged.PERF_MONITOR_ENABLED, DEFAULT_SHARED_CONFIG.perfMonitorEnabled),
    perfMonitorSampleIntervalMs: Number.parseInt(
      merged.PERF_MONITOR_SAMPLE_INTERVAL_MS ?? `${DEFAULT_SHARED_CONFIG.perfMonitorSampleIntervalMs}`,
      10
    ),
    perfMonitorRetentionDays: Number.parseInt(
      merged.PERF_MONITOR_RETENTION_DAYS ?? `${DEFAULT_SHARED_CONFIG.perfMonitorRetentionDays}`,
      10
    ),
    appServerGuardEnabled: parseBooleanEnv(merged.APP_SERVER_GUARD_ENABLED, DEFAULT_SHARED_CONFIG.appServerGuardEnabled),
    appServerGuardSampleIntervalMs: Number.parseInt(
      merged.APP_SERVER_GUARD_SAMPLE_INTERVAL_MS ?? `${DEFAULT_SHARED_CONFIG.appServerGuardSampleIntervalMs}`,
      10
    ),
    appServerGuardMcpWorkerThreshold: Number.parseInt(
      merged.APP_SERVER_GUARD_MCP_WORKER_THRESHOLD ?? `${DEFAULT_SHARED_CONFIG.appServerGuardMcpWorkerThreshold}`,
      10
    ),
    appServerGuardConsecutiveWindows: Number.parseInt(
      merged.APP_SERVER_GUARD_CONSECUTIVE_WINDOWS ?? `${DEFAULT_SHARED_CONFIG.appServerGuardConsecutiveWindows}`,
      10
    ),
    appServerGuardCooldownMs: Number.parseInt(
      merged.APP_SERVER_GUARD_COOLDOWN_MS ?? `${DEFAULT_SHARED_CONFIG.appServerGuardCooldownMs}`,
      10
    )
  };
  const packs = Object.fromEntries(
    listSupportedBridgePacks().map((packName) => {
      const entry = getBridgePackCatalogEntry(packName);
      return [packName, entry.configCodec.readFromEnv(merged, paths.homeDir)];
    })
  ) as Partial<Record<BridgePackName, unknown>>;

  const config: BridgeConfig = {
    activePack,
    shared,
    packs,
    codexBin: shared.codexBin,
    projectScanRoots: shared.projectScanRoots,
    voiceInputEnabled: shared.voiceInputEnabled,
    voiceTranscriptionProvider: shared.voiceTranscriptionProvider ?? "auto",
    voiceWhisperPythonBin: shared.voiceWhisperPythonBin ?? "python3",
    voiceWhisperModel: shared.voiceWhisperModel ?? "small",
    voiceWhisperLanguage: shared.voiceWhisperLanguage ?? "en",
    voiceOpenaiApiKey: shared.voiceOpenaiApiKey,
    voiceOpenaiTranscribeModel: shared.voiceOpenaiTranscribeModel,
    voiceFfmpegBin: shared.voiceFfmpegBin,
    perfMonitorEnabled: shared.perfMonitorEnabled,
    perfMonitorSampleIntervalMs: shared.perfMonitorSampleIntervalMs,
    perfMonitorRetentionDays: shared.perfMonitorRetentionDays,
    appServerGuardEnabled: shared.appServerGuardEnabled ?? DEFAULT_SHARED_CONFIG.appServerGuardEnabled,
    appServerGuardSampleIntervalMs:
      shared.appServerGuardSampleIntervalMs ?? DEFAULT_SHARED_CONFIG.appServerGuardSampleIntervalMs,
    appServerGuardMcpWorkerThreshold:
      shared.appServerGuardMcpWorkerThreshold ?? DEFAULT_SHARED_CONFIG.appServerGuardMcpWorkerThreshold,
    appServerGuardConsecutiveWindows:
      shared.appServerGuardConsecutiveWindows ?? DEFAULT_SHARED_CONFIG.appServerGuardConsecutiveWindows,
    appServerGuardCooldownMs: shared.appServerGuardCooldownMs ?? DEFAULT_SHARED_CONFIG.appServerGuardCooldownMs
  };

  validateConfig(config);
  return config;
}

export async function writeConfig(paths: BridgePaths, config: BridgeConfig): Promise<void> {
  const content = Object.entries(buildConfigEnvironment(config))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  await writeFile(paths.envPath, `${content}\n`, "utf8");
}

export function withInstallOverrides(current: BridgeConfig, overrides: BridgeInstallOverrides): BridgeConfig {
  const currentShared = current.shared;
  const activePack = overrides.activePack ?? current.activePack ?? currentShared.activePack ?? DEFAULT_SHARED_CONFIG.activePack;
  const shared: SharedBridgeConfig = {
    activePack,
    codexBin: overrides.codexBin ?? currentShared.codexBin,
    projectScanRoots: overrides.projectScanRoots ?? currentShared.projectScanRoots,
    voiceInputEnabled: overrides.voiceInputEnabled ?? currentShared.voiceInputEnabled,
    voiceTranscriptionProvider: overrides.voiceTranscriptionProvider ?? currentShared.voiceTranscriptionProvider ?? "auto",
    voiceWhisperPythonBin: overrides.voiceWhisperPythonBin ?? currentShared.voiceWhisperPythonBin ?? "python3",
    voiceWhisperModel: overrides.voiceWhisperModel ?? currentShared.voiceWhisperModel ?? "small",
    voiceWhisperLanguage: overrides.voiceWhisperLanguage ?? currentShared.voiceWhisperLanguage ?? "en",
    voiceOpenaiApiKey: overrides.voiceOpenaiApiKey ?? currentShared.voiceOpenaiApiKey,
    voiceOpenaiTranscribeModel: overrides.voiceOpenaiTranscribeModel ?? currentShared.voiceOpenaiTranscribeModel,
    voiceFfmpegBin: overrides.voiceFfmpegBin ?? currentShared.voiceFfmpegBin,
    perfMonitorEnabled: overrides.perfMonitorEnabled ?? currentShared.perfMonitorEnabled,
    perfMonitorSampleIntervalMs: overrides.perfMonitorSampleIntervalMs ?? currentShared.perfMonitorSampleIntervalMs,
    perfMonitorRetentionDays: overrides.perfMonitorRetentionDays ?? currentShared.perfMonitorRetentionDays,
    appServerGuardEnabled: overrides.appServerGuardEnabled
      ?? currentShared.appServerGuardEnabled
      ?? DEFAULT_SHARED_CONFIG.appServerGuardEnabled,
    appServerGuardSampleIntervalMs: overrides.appServerGuardSampleIntervalMs
      ?? currentShared.appServerGuardSampleIntervalMs
      ?? DEFAULT_SHARED_CONFIG.appServerGuardSampleIntervalMs,
    appServerGuardMcpWorkerThreshold: overrides.appServerGuardMcpWorkerThreshold
      ?? currentShared.appServerGuardMcpWorkerThreshold
      ?? DEFAULT_SHARED_CONFIG.appServerGuardMcpWorkerThreshold,
    appServerGuardConsecutiveWindows: overrides.appServerGuardConsecutiveWindows
      ?? currentShared.appServerGuardConsecutiveWindows
      ?? DEFAULT_SHARED_CONFIG.appServerGuardConsecutiveWindows,
    appServerGuardCooldownMs: overrides.appServerGuardCooldownMs
      ?? currentShared.appServerGuardCooldownMs
      ?? DEFAULT_SHARED_CONFIG.appServerGuardCooldownMs
  };
  const packs: Partial<Record<BridgePackName, unknown>> = {
    ...current.packs
  };
  const activePackEntry = getBridgePackCatalogEntry(activePack);
  packs[activePack] = activePackEntry.configCodec.applyInstallOptions(
    current.packs[activePack] as never,
    overrides.packOptions ?? {}
  );

  const config: BridgeConfig = {
    activePack,
    shared,
    packs,
    codexBin: shared.codexBin,
    projectScanRoots: shared.projectScanRoots,
    voiceInputEnabled: shared.voiceInputEnabled,
    voiceTranscriptionProvider: shared.voiceTranscriptionProvider ?? "auto",
    voiceWhisperPythonBin: shared.voiceWhisperPythonBin ?? "python3",
    voiceWhisperModel: shared.voiceWhisperModel ?? "small",
    voiceWhisperLanguage: shared.voiceWhisperLanguage ?? "en",
    voiceOpenaiApiKey: shared.voiceOpenaiApiKey,
    voiceOpenaiTranscribeModel: shared.voiceOpenaiTranscribeModel,
    voiceFfmpegBin: shared.voiceFfmpegBin,
    perfMonitorEnabled: shared.perfMonitorEnabled,
    perfMonitorSampleIntervalMs: shared.perfMonitorSampleIntervalMs,
    perfMonitorRetentionDays: shared.perfMonitorRetentionDays,
    appServerGuardEnabled: shared.appServerGuardEnabled ?? DEFAULT_SHARED_CONFIG.appServerGuardEnabled,
    appServerGuardSampleIntervalMs:
      shared.appServerGuardSampleIntervalMs ?? DEFAULT_SHARED_CONFIG.appServerGuardSampleIntervalMs,
    appServerGuardMcpWorkerThreshold:
      shared.appServerGuardMcpWorkerThreshold ?? DEFAULT_SHARED_CONFIG.appServerGuardMcpWorkerThreshold,
    appServerGuardConsecutiveWindows:
      shared.appServerGuardConsecutiveWindows ?? DEFAULT_SHARED_CONFIG.appServerGuardConsecutiveWindows,
    appServerGuardCooldownMs: shared.appServerGuardCooldownMs ?? DEFAULT_SHARED_CONFIG.appServerGuardCooldownMs
  };

  validateConfig(config);
  return config;
}
