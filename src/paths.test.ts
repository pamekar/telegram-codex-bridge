import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureBridgeDirectories, getBridgePaths, type BridgePaths } from "./paths.js";

function createCustomPaths(root: string): BridgePaths {
  const installRoot = join(root, "install-root");
  const stateRoot = join(root, "state-root");
  const configRoot = join(root, "config-root");
  const logsDir = join(root, "var", "logs");
  const telegramSessionFlowLogsDir = join(logsDir, "telegram-session-flow");
  const runtimeDir = join(root, "var", "runtime");
  const cacheDir = join(root, "var", "cache");

  return {
    homeDir: root,
    repoRoot: join(root, "repo"),
    installRoot,
    stateRoot,
    configRoot,
    logsDir,
    perfLogsDir: join(logsDir, "perf"),
    telegramSessionFlowLogsDir,
    runtimeDir,
    cacheDir,
    dbPath: join(stateRoot, "bridge.db"),
    stateStoreFailurePath: join(stateRoot, "state-store-open-failure.json"),
    envPath: join(configRoot, "bridge.env"),
    servicePath: join(root, "systemd", "bridge.service"),
    launchAgentPath: join(root, "LaunchAgents", "bridge.plist"),
    binPath: join(root, "bin", "ctb"),
    manifestPath: join(installRoot, "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(logsDir, "bridge.log"),
    bootstrapLogPath: join(logsDir, "bootstrap.log"),
    appServerLogPath: join(logsDir, "app-server.log"),
    telegramStatusCardLogPath: join(telegramSessionFlowLogsDir, "status-card.log"),
    telegramPlanCardLogPath: join(telegramSessionFlowLogsDir, "plan-card.log"),
    telegramErrorCardLogPath: join(telegramSessionFlowLogsDir, "error-card.log")
  };
}

async function assertExists(path: string): Promise<void> {
  await access(path);
}

test("ensureBridgeDirectories creates install and state roots for custom path layouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-paths-test-"));
  const paths = {
    ...createCustomPaths(root),
    perfLogsDir: join(root, "var", "logs", "perf")
  } as BridgePaths & { perfLogsDir: string };

  try {
    await ensureBridgeDirectories(paths as any);

    await assertExists(paths.installRoot);
    await assertExists(paths.stateRoot);
    await assertExists(paths.configRoot);
    await assertExists(paths.logsDir);
    await assertExists(paths.perfLogsDir);
    await assertExists(paths.telegramSessionFlowLogsDir);
    await assertExists(paths.cacheDir);
    await assertExists(paths.runtimeDir);
    await assertExists(join(paths.runtimeDir, "debug"));
    await assertExists(join(root, "systemd"));
    await assertExists(join(root, "LaunchAgents"));
    await assertExists(join(root, "bin"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getBridgePaths uses Windows-friendly roots and wrappers on win32", () => {
  if (process.platform !== "win32") {
    return;
  }

  const paths = getBridgePaths(
    "file:///C:/Users/example/repo/src/cli.ts",
    "C:\\Users\\example",
    "win32",
    {
      LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
      APPDATA: "C:\\Users\\example\\AppData\\Roaming"
    }
  );

  assert.match(paths.installRoot, /AppData\\Local\\codex-telegram-bridge$/u);
  assert.match(paths.stateRoot, /AppData\\Local\\codex-telegram-bridge$/u);
  assert.match(paths.configRoot, /AppData\\Roaming\\codex-telegram-bridge$/u);
  assert.match(paths.binPath, /codex-telegram-bridge\\bin\\ctb\.cmd$/u);
  assert.equal(paths.taskSchedulerName, "CodexTelegramBridge");
  assert.match(paths.powershellWrapperPath ?? "", /codex-telegram-bridge\\bin\\ctb\.ps1$/u);
  assert.match((paths as any).perfLogsDir ?? "", /codex-telegram-bridge\\logs\\perf$/u);
});

test("getBridgePaths isolates named instance state and config while sharing the installation", () => {
  const paths = getBridgePaths(
    "file:///home/example/repo/dist/cli.js",
    "/home/example",
    "linux",
    { CTB_INSTANCE: "session2" }
  );

  assert.equal(paths.installRoot, "/home/example/.local/share/codex-telegram-bridge");
  assert.equal(paths.stateRoot, "/home/example/.local/state/codex-telegram-bridge-session2");
  assert.equal(paths.configRoot, "/home/example/.config/codex-telegram-bridge-session2");
  assert.equal(paths.dbPath, "/home/example/.local/state/codex-telegram-bridge-session2/bridge.db");
  assert.equal(paths.offsetPath, "/home/example/.local/state/codex-telegram-bridge-session2/runtime/telegram-offset.json");
});

test("getBridgePaths rejects unsafe instance names", () => {
  assert.throws(
    () => getBridgePaths(
      "file:///home/example/repo/dist/cli.js",
      "/home/example",
      "linux",
      { CTB_INSTANCE: "../session2" }
    ),
    /CTB_INSTANCE must contain/u
  );
});
