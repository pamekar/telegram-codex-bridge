import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { loadConfig, withInstallOverrides, writeConfig, type BridgeConfig } from "./config.js";
import type { BridgePaths } from "./paths.js";

function createBridgeConfig(root: string): BridgeConfig {
  return {
    activePack: "telegram",
    shared: {
      activePack: "telegram",
      codexBin: "codex",
      projectScanRoots: [],
      voiceInputEnabled: false,
      voiceOpenaiApiKey: "",
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
    },
    packs: {
      telegram: {
        botToken: "test-token",
        apiBaseUrl: "https://api.telegram.org",
        pollTimeoutSeconds: 20,
        pollIntervalMs: 1500
      }
    },
    codexBin: "codex",
    projectScanRoots: [],
    voiceInputEnabled: false,
    voiceOpenaiApiKey: "",
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
  };
}

function createTestPaths(root: string): BridgePaths {
  const logsDir = join(root, "logs");
  const telegramSessionFlowLogsDir = join(logsDir, "telegram-session-flow");
  const runtimeDir = join(root, "runtime");

  return {
    homeDir: root,
    repoRoot: root,
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    logsDir,
    perfLogsDir: join(logsDir, "perf"),
    telegramSessionFlowLogsDir,
    runtimeDir,
    cacheDir: join(root, "cache"),
    dbPath: join(root, "state", "bridge.db"),
    stateStoreFailurePath: join(root, "state", "state-store-open-failure.json"),
    envPath: join(root, "config", "bridge.env"),
    servicePath: join(root, "service", "bridge.service"),
    launchAgentPath: join(root, "LaunchAgents", "bridge.plist"),
    binPath: join(root, "bin", "ctb"),
    manifestPath: join(root, "install", "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(logsDir, "bridge.log"),
    bootstrapLogPath: join(logsDir, "bootstrap.log"),
    appServerLogPath: join(logsDir, "app-server.log"),
    telegramStatusCardLogPath: join(telegramSessionFlowLogsDir, "status-card.log"),
    telegramPlanCardLogPath: join(telegramSessionFlowLogsDir, "plan-card.log"),
    telegramErrorCardLogPath: join(telegramSessionFlowLogsDir, "error-card.log")
  };
}

test("loadConfig parses PROJECT_SCAN_ROOTS from bridge.env", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(
      paths.envPath,
      [
        "TELEGRAM_BOT_TOKEN=test-token",
        `PROJECT_SCAN_ROOTS=~/projects${delimiter}${join(root, "work")}${delimiter}~/projects`
      ].join("\n"),
      "utf8"
    );

    const config = await loadConfig(paths);

    assert.deepEqual(config.projectScanRoots, [join(root, "projects"), join(root, "work")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig parses boolean-like VOICE_INPUT_ENABLED values from bridge.env", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(
      paths.envPath,
      [
        "TELEGRAM_BOT_TOKEN=test-token",
        "VOICE_INPUT_ENABLED=on"
      ].join("\n"),
      "utf8"
    );

    const config = await loadConfig(paths);

    assert.equal(config.voiceInputEnabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig prefers bridge.env over ambient process env for persisted bridge settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);
  const originalProjectScanRoots = process.env.PROJECT_SCAN_ROOTS;
  const originalVoiceInputEnabled = process.env.VOICE_INPUT_ENABLED;

  try {
    process.env.PROJECT_SCAN_ROOTS = "";
    process.env.VOICE_INPUT_ENABLED = "0";

    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(
      paths.envPath,
      [
        "TELEGRAM_BOT_TOKEN=test-token",
        `PROJECT_SCAN_ROOTS=~/projects${delimiter}${join(root, "work")}`,
        "VOICE_INPUT_ENABLED=on"
      ].join("\n"),
      "utf8"
    );

    const config = await loadConfig(paths);

    assert.deepEqual(config.projectScanRoots, [join(root, "projects"), join(root, "work")]);
    assert.equal(config.voiceInputEnabled, true);
  } finally {
    if (originalProjectScanRoots === undefined) {
      delete process.env.PROJECT_SCAN_ROOTS;
    } else {
      process.env.PROJECT_SCAN_ROOTS = originalProjectScanRoots;
    }

    if (originalVoiceInputEnabled === undefined) {
      delete process.env.VOICE_INPUT_ENABLED;
    } else {
      process.env.VOICE_INPUT_ENABLED = originalVoiceInputEnabled;
    }

    await rm(root, { recursive: true, force: true });
  }
});

test("writeConfig persists PROJECT_SCAN_ROOTS and withInstallOverrides can replace them", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);
  const initialConfig: BridgeConfig = {
    ...createBridgeConfig(root),
    shared: {
      ...createBridgeConfig(root).shared,
      projectScanRoots: [join(root, "projects"), join(root, "work")]
    },
    projectScanRoots: [join(root, "projects"), join(root, "work")]
  };

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeConfig(paths, initialConfig);

    const content = await readFile(paths.envPath, "utf8");
    assert.match(
      content,
      new RegExp(`^PROJECT_SCAN_ROOTS=${join(root, "projects")}${delimiter}${join(root, "work")}$`, "mu")
    );

    const nextConfig = withInstallOverrides(initialConfig, {
      projectScanRoots: [join(root, "code")]
    });
    assert.deepEqual(nextConfig.projectScanRoots, [join(root, "code")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig parses perf monitor settings from bridge.env", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(
      paths.envPath,
      [
        "TELEGRAM_BOT_TOKEN=test-token",
        "PERF_MONITOR_ENABLED=1",
        "PERF_MONITOR_SAMPLE_INTERVAL_MS=2500",
        "PERF_MONITOR_RETENTION_DAYS=14"
      ].join("\n"),
      "utf8"
    );

    const config = await loadConfig(paths);

    assert.equal((config as any).perfMonitorEnabled, true);
    assert.equal((config as any).perfMonitorSampleIntervalMs, 2500);
    assert.equal((config as any).perfMonitorRetentionDays, 14);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeConfig persists perf monitor settings and withInstallOverrides can replace them", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);
  const initialConfig = {
    ...createBridgeConfig(root),
    shared: {
      ...createBridgeConfig(root).shared,
      perfMonitorEnabled: true
    },
    perfMonitorEnabled: true
  } as BridgeConfig & {
    perfMonitorEnabled: boolean;
    perfMonitorSampleIntervalMs: number;
    perfMonitorRetentionDays: number;
    appServerGuardEnabled: boolean;
    appServerGuardSampleIntervalMs: number;
    appServerGuardMcpWorkerThreshold: number;
    appServerGuardConsecutiveWindows: number;
    appServerGuardCooldownMs: number;
  };

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeConfig(paths, initialConfig);

    const content = await readFile(paths.envPath, "utf8");
    assert.match(content, /^PERF_MONITOR_ENABLED=1$/mu);
    assert.match(content, /^PERF_MONITOR_SAMPLE_INTERVAL_MS=15000$/mu);
    assert.match(content, /^PERF_MONITOR_RETENTION_DAYS=7$/mu);

    const nextConfig = withInstallOverrides(initialConfig, {
      perfMonitorEnabled: false,
      perfMonitorSampleIntervalMs: 3000,
      perfMonitorRetentionDays: 30
    } as any) as typeof initialConfig;
    assert.equal(nextConfig.perfMonitorEnabled, false);
    assert.equal(nextConfig.perfMonitorSampleIntervalMs, 3000);
    assert.equal(nextConfig.perfMonitorRetentionDays, 30);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig parses app server guard settings from bridge.env", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(
      paths.envPath,
      [
        "TELEGRAM_BOT_TOKEN=test-token",
        "APP_SERVER_GUARD_ENABLED=0",
        "APP_SERVER_GUARD_SAMPLE_INTERVAL_MS=20000",
        "APP_SERVER_GUARD_MCP_WORKER_THRESHOLD=9",
        "APP_SERVER_GUARD_CONSECUTIVE_WINDOWS=5",
        "APP_SERVER_GUARD_COOLDOWN_MS=120000"
      ].join("\n"),
      "utf8"
    );

    const config = await loadConfig(paths);
    assert.equal(config.appServerGuardEnabled, false);
    assert.equal(config.appServerGuardSampleIntervalMs, 20_000);
    assert.equal(config.appServerGuardMcpWorkerThreshold, 9);
    assert.equal(config.appServerGuardConsecutiveWindows, 5);
    assert.equal(config.appServerGuardCooldownMs, 120_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeConfig persists app server guard settings and withInstallOverrides can replace them", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);
  const initialConfig: BridgeConfig = {
    ...createBridgeConfig(root),
    shared: {
      ...createBridgeConfig(root).shared,
      perfMonitorEnabled: true
    },
    perfMonitorEnabled: true
  };

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeConfig(paths, initialConfig);

    const content = await readFile(paths.envPath, "utf8");
    assert.match(content, /^APP_SERVER_GUARD_ENABLED=1$/mu);
    assert.match(content, /^APP_SERVER_GUARD_SAMPLE_INTERVAL_MS=30000$/mu);
    assert.match(content, /^APP_SERVER_GUARD_MCP_WORKER_THRESHOLD=6$/mu);
    assert.match(content, /^APP_SERVER_GUARD_CONSECUTIVE_WINDOWS=3$/mu);
    assert.match(content, /^APP_SERVER_GUARD_COOLDOWN_MS=900000$/mu);

    const nextConfig = withInstallOverrides(initialConfig, {
      appServerGuardEnabled: false,
      appServerGuardSampleIntervalMs: 45_000,
      appServerGuardMcpWorkerThreshold: 4,
      appServerGuardConsecutiveWindows: 2,
      appServerGuardCooldownMs: 600_000
    });
    assert.equal(nextConfig.appServerGuardEnabled, false);
    assert.equal(nextConfig.appServerGuardSampleIntervalMs, 45_000);
    assert.equal(nextConfig.appServerGuardMcpWorkerThreshold, 4);
    assert.equal(nextConfig.appServerGuardConsecutiveWindows, 2);
    assert.equal(nextConfig.appServerGuardCooldownMs, 600_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("local voice configuration survives install overrides and config writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-local-config-test-"));
  const paths = createTestPaths(root);
  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(paths.envPath, "TELEGRAM_BOT_TOKEN=test-token\nVOICE_INPUT_ENABLED=1\nVOICE_TRANSCRIPTION_PROVIDER=faster-whisper\nVOICE_WHISPER_PYTHON_BIN=/venv/bin/python\nVOICE_WHISPER_MODEL=small\nVOICE_WHISPER_LANGUAGE=en\n");
    const config = withInstallOverrides(await loadConfig(paths), {});
    await writeConfig(paths, config);
    const reloaded = await loadConfig(paths);
    assert.equal(reloaded.voiceTranscriptionProvider, "faster-whisper");
    assert.equal(reloaded.shared.voiceWhisperPythonBin, "/venv/bin/python");
    assert.equal(reloaded.voiceWhisperModel, "small");
    assert.equal(reloaded.voiceWhisperLanguage, "en");
    await writeFile(paths.envPath, "VOICE_TRANSCRIPTION_PROVIDER=typo\n");
    await assert.rejects(loadConfig(paths), /must be auto or faster-whisper/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
