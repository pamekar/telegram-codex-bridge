import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CodexAppServerClient } from "./codex/app-server.js";
import type { Logger } from "./logger.js";
import type { BridgePaths } from "./paths.js";
import { buildFeishuSetupHealth, mergeStoredFeishuSetupMetadata } from "./packs/feishu/setup.js";
import { getActiveBridgePack } from "./packs/registry.js";
import type { PackHealthReport } from "./packs/contract.js";
import { commandExists, resolveCommand, runCommand, type CommandResult } from "./process.js";
import { getHostPlatform, type ServiceManager } from "./platform.js";
import type { BridgeConfig } from "./config.js";
import type { BridgeStateStore } from "./state/store.js";
import type { ReadinessDetails, ReadinessSnapshot } from "./types.js";
import { normalizeWhitespace } from "./util/text.js";
import { readRepoPackageJson } from "./util/package-json.js";

const NODE_ENGINE_FALLBACK = ">=24.0.0";
const MIN_CODEX_VERSION = [0, 114, 0] as const;
const REQUIRED_CLIENT_REQUESTS = [
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/archive",
  "thread/unarchive",
  "turn/start",
  "turn/interrupt"
] as const;
const REQUIRED_SERVER_NOTIFICATIONS = [
  "thread/started",
  "thread/name/updated",
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "item/started",
  "item/completed",
  "item/mcpToolCall/progress",
  "turn/plan/updated",
  "thread/archived",
  "thread/unarchived",
  "error"
] as const;
const CAPABILITY_CACHE_FORMAT_VERSION = 1;
const CAPABILITY_REQUIREMENTS_FINGERPRINT = JSON.stringify({
  clientRequests: [...REQUIRED_CLIENT_REQUESTS],
  serverNotifications: [...REQUIRED_SERVER_NOTIFICATIONS]
});

type ServiceManagerHealth = "ok" | "warning" | "error";
type CapabilityCheckSource = "cache" | "generated_schema" | "unknown";

interface ServiceManagerStatus {
  manager: ServiceManager;
  health: ServiceManagerHealth;
  issues: string[];
}

interface CapabilityCheckSummary {
  ok: boolean;
  source: CapabilityCheckSource;
  issues: string[];
}

interface CapabilityCheckCacheEntry {
  version: number;
  requirementsFingerprint: string;
  summary: CapabilityCheckSummary;
}

interface AppServerLifecycle {
  pid?: number | null;
  initializeAndProbe(): Promise<void>;
  listModels?(options?: {
    cursor?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<{
    data: Array<{
      inputModalities?: string[];
    }>;
    nextCursor?: string | null;
  }>;
  stop(): Promise<void>;
}

interface ReadinessDependencies {
  nodeVersion?: string;
  commandExists?: typeof commandExists;
  resolveCommand?: typeof resolveCommand;
  runCommand?: typeof runCommand;
  detectServiceManager?: (deps: {
    commandExists: typeof commandExists;
  }) => Promise<ServiceManagerStatus>;
  createAppServer?: (options: {
    codexBin: string;
    appServerLogPath: string;
    logger: Logger;
    experimentalApi: boolean;
  }) => AppServerLifecycle;
  runPackHealthCheck?: (options: {
    pack: ReturnType<typeof getActiveBridgePack>;
    config: BridgeConfig;
    store: BridgeStateStore;
    logger: Logger;
  }) => Promise<PackHealthReport>;
  evaluateCapabilities?: (options: {
    codexBin: string;
    codexVersionText: string;
    paths: BridgePaths;
    runCommand: typeof runCommand;
  }) => Promise<CapabilityCheckSummary>;
}

export interface ReadinessProbeResult {
  snapshot: ReadinessSnapshot;
  appServer: CodexAppServerClient | null;
}

function buildSnapshot(
  state: ReadinessSnapshot["state"],
  details: ReadinessDetails,
  appServerPid?: number | null
): ReadinessSnapshot {
  return {
    state,
    checkedAt: new Date().toISOString(),
    details,
    appServerPid: appServerPid === null || appServerPid === undefined ? null : `${appServerPid}`
  };
}

function normalizeIssue(message: string): string {
  return normalizeWhitespace(message);
}

function finalizeFailure(
  state: ReadinessSnapshot["state"],
  details: ReadinessDetails,
  store: BridgeStateStore,
  persist: boolean
): ReadinessProbeResult {
  const snapshot = buildSnapshot(state, details);
  if (persist) {
    store.writeReadinessSnapshot(snapshot);
  }
  return { snapshot, appServer: null };
}

function parseVersionParts(text: string): number[] | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/u);
  if (!match) {
    return null;
  }

  return match.slice(1, 4).map((value) => Number.parseInt(value, 10));
}

function isVersionAtLeast(versionText: string, minimum: readonly number[]): boolean {
  const actual = parseVersionParts(versionText);
  if (!actual) {
    return false;
  }

  for (let index = 0; index < minimum.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left > right) {
      return true;
    }
    if (left < right) {
      return false;
    }
  }

  return true;
}

async function readDeclaredNodeEngine(paths: BridgePaths): Promise<string> {
  try {
    const packageJson = await readRepoPackageJson<{
      engines?: {
        node?: string;
      };
    }>(paths);
    return packageJson.engines?.node ?? NODE_ENGINE_FALLBACK;
  } catch {
    return NODE_ENGINE_FALLBACK;
  }
}

function normalizeVersionLabel(versionText: string): string {
  const parts = parseVersionParts(versionText);
  return parts ? parts.join(".") : versionText.replace(/[^\w.-]+/gu, "_");
}

async function isDirectoryWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultDetectServiceManager(deps: {
  commandExists: typeof commandExists;
}): Promise<ServiceManagerStatus> {
  const hostPlatform = getHostPlatform();

  if (hostPlatform === "darwin" && await deps.commandExists("launchctl")) {
    return {
      manager: "launchd",
      health: "ok",
      issues: []
    };
  }

  if (hostPlatform === "win32" && await deps.commandExists("powershell.exe")) {
    return {
      manager: "task_scheduler",
      health: "ok",
      issues: []
    };
  }

  if (await deps.commandExists("systemctl")) {
    return {
      manager: "systemd",
      health: "ok",
      issues: []
    };
  }

  return {
    manager: "none",
    health: "warning",
    issues: ["no supported service manager found"]
  };
}

function defaultCreateAppServer(options: {
  codexBin: string;
  appServerLogPath: string;
  logger: Logger;
  experimentalApi: boolean;
}): AppServerLifecycle {
  return new CodexAppServerClient(
    options.codexBin,
    options.appServerLogPath,
    options.logger,
    5000,
    {
      experimentalApi: options.experimentalApi
    }
  );
}

async function hasAudioCapableModel(appServer: AppServerLifecycle): Promise<boolean> {
  if (!appServer.listModels) {
    return false;
  }

  let cursor: string | null = null;

  do {
    const page = await appServer.listModels({
      ...(cursor ? { cursor } : {}),
      includeHidden: false,
      limit: 50
    });
    if (page.data.some((model) => (model.inputModalities ?? []).includes("audio"))) {
      return true;
    }
    cursor = page.nextCursor ?? null;
  } while (cursor);

  return false;
}

function extractMethodsFromSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const oneOf = (schema as { oneOf?: unknown[] }).oneOf;
  if (!Array.isArray(oneOf)) {
    return [];
  }

  return oneOf.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const methodEnum = (entry as {
      properties?: {
        method?: {
          enum?: string[];
        };
      };
    }).properties?.method?.enum;
    return Array.isArray(methodEnum) ? methodEnum : [];
  });
}

async function loadCapabilityCache(cacheFilePath: string): Promise<CapabilityCheckSummary | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheFilePath, "utf8")) as CapabilityCheckCacheEntry;
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.version !== CAPABILITY_CACHE_FORMAT_VERSION
      || parsed.requirementsFingerprint !== CAPABILITY_REQUIREMENTS_FINGERPRINT
    ) {
      return null;
    }

    const summary = parsed.summary;
    if (
      summary &&
      typeof summary === "object" &&
      typeof summary.ok === "boolean" &&
      Array.isArray(summary.issues) &&
      (summary.source === "generated_schema" || summary.source === "unknown" || summary.source === "cache")
    ) {
      return {
        ok: summary.ok,
        issues: summary.issues.map((issue) => normalizeIssue(`${issue}`)),
        source: "cache"
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCapabilityCache(cacheFilePath: string, summary: CapabilityCheckSummary): Promise<void> {
  await mkdir(dirname(cacheFilePath), { recursive: true }).catch(() => {});
  const entry: CapabilityCheckCacheEntry = {
    version: CAPABILITY_CACHE_FORMAT_VERSION,
    requirementsFingerprint: CAPABILITY_REQUIREMENTS_FINGERPRINT,
    summary
  };
  await writeFile(cacheFilePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

async function defaultEvaluateCapabilities(options: {
  codexBin: string;
  codexVersionText: string;
  paths: BridgePaths;
  runCommand: typeof runCommand;
}): Promise<CapabilityCheckSummary> {
  const cacheFilePath = join(
    options.paths.cacheDir,
    `codex-capabilities-${normalizeVersionLabel(options.codexVersionText)}.json`
  );
  const cached = await loadCapabilityCache(cacheFilePath);
  if (cached) {
    return cached;
  }

  const schemaDir = await mkdtemp(join(tmpdir(), "ctb-codex-schema-"));

  try {
    const generation = await options.runCommand(options.codexBin, [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      schemaDir
    ]);
    if (generation.exitCode !== 0) {
      return {
        ok: false,
        source: "generated_schema",
        issues: [generation.stderr || generation.stdout || "failed to generate app-server schema"]
      } satisfies CapabilityCheckSummary;
    }

    const clientRequestSchema = JSON.parse(await readFile(join(schemaDir, "ClientRequest.json"), "utf8"));
    const serverNotificationSchema = JSON.parse(await readFile(join(schemaDir, "ServerNotification.json"), "utf8"));
    const clientRequests = new Set(extractMethodsFromSchema(clientRequestSchema));
    const notifications = new Set(extractMethodsFromSchema(serverNotificationSchema));

    const issues = [
      ...REQUIRED_CLIENT_REQUESTS
        .filter((method) => !clientRequests.has(method))
        .map((method) => `missing request: ${method}`),
      ...REQUIRED_SERVER_NOTIFICATIONS
        .filter((method) => !notifications.has(method))
        .map((method) => `missing notification: ${method}`)
    ];
    const summary = {
      ok: issues.length === 0,
      source: "generated_schema",
      issues
    } satisfies CapabilityCheckSummary;
    await mkdir(options.paths.cacheDir, { recursive: true });
    await writeCapabilityCache(cacheFilePath, summary);
    return summary;
  } catch (error) {
    return {
      ok: false,
      source: "unknown",
      issues: [`capability check failed: ${error}`]
    } satisfies CapabilityCheckSummary;
  } finally {
    await rm(schemaDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function probeReadiness(options: {
  config: BridgeConfig;
  store: BridgeStateStore;
  paths: BridgePaths;
  logger: Logger;
  keepAppServer?: boolean;
  persist?: boolean;
  deps?: ReadinessDependencies;
}): Promise<ReadinessProbeResult> {
  const { config, store, paths, logger } = options;
  const persist = options.persist ?? true;
  const deps = {
    nodeVersion: options.deps?.nodeVersion ?? process.version,
    commandExists: options.deps?.commandExists ?? commandExists,
    resolveCommand: options.deps?.resolveCommand ?? (async (command: string) => {
      if (options.deps?.commandExists) {
        if (await options.deps.commandExists(command)) {
          return {
            requestedCommand: command,
            resolvedPath: command,
            invocation: "direct" as const,
            launchCommand: command,
            launchArgsPrefix: []
          };
        }

        return null;
      }

      const resolved = await resolveCommand(command);
      if (resolved) {
        return resolved;
      }

      if (await commandExists(command)) {
        return {
          requestedCommand: command,
          resolvedPath: command,
          invocation: "direct" as const,
          launchCommand: command,
          launchArgsPrefix: []
        };
      }

      return null;
    }),
    runCommand: options.deps?.runCommand ?? runCommand,
    detectServiceManager: options.deps?.detectServiceManager ?? defaultDetectServiceManager,
    createAppServer: options.deps?.createAppServer ?? defaultCreateAppServer,
    runPackHealthCheck: options.deps?.runPackHealthCheck,
    evaluateCapabilities: options.deps?.evaluateCapabilities ?? defaultEvaluateCapabilities
  };
  const pack = getActiveBridgePack(config);
  const sharedChecks: NonNullable<ReadinessDetails["sharedChecks"]> = [];
  const packChecks: NonNullable<ReadinessDetails["packChecks"]> = [];
  const sharedIssues: string[] = [];
  const packIssues: string[] = [];
  const details: ReadinessDetails = {
    activePack: config.activePack,
    codexInstalled: false,
    codexAuthenticated: false,
    appServerAvailable: false,
    packState: "awaiting_authorization",
    setupState: "complete",
    packMetadata: {},
    authorizedUserBound: store.getAuthorizedUser(config.activePack) !== null,
    issues: [],
    sharedChecks,
    packChecks,
    sharedIssues,
    packIssues,
    nodeVersion: deps.nodeVersion,
    voiceInputEnabled: config.voiceInputEnabled,
    ...(config.voiceInputEnabled ? {
      voiceOpenaiConfigured: config.voiceOpenaiApiKey.trim().length > 0,
      voiceRealtimeSupported: false
    } : {})
  };

  if (config.voiceInputEnabled && config.voiceTranscriptionProvider === "faster-whisper") {
    try {
      const probe = await deps.runCommand(config.voiceWhisperPythonBin || "python3", ["-c", "import faster_whisper"]);
      details.voiceLocalAvailable = probe.exitCode === 0;
    } catch {
      details.voiceLocalAvailable = false;
    }
  } else if (config.voiceInputEnabled) {
    const resolvedFfmpeg = await deps.resolveCommand(config.voiceFfmpegBin);
    details.voiceFfmpegAvailable = resolvedFfmpeg !== null;
    if (resolvedFfmpeg) {
      details.voiceFfmpegResolvedPath = resolvedFfmpeg.resolvedPath;
    }
  }

  const requiredNodeRange = await readDeclaredNodeEngine(paths);
  details.nodeVersionSupported = isVersionAtLeast(deps.nodeVersion, parseVersionParts(requiredNodeRange) ?? [24, 0, 0]);
  if (!details.nodeVersionSupported) {
    const summary = `Node ${deps.nodeVersion} does not satisfy required range ${requiredNodeRange}`;
    sharedChecks.push({ id: "node_version", ok: false, summary });
    sharedIssues.push(summary);
    details.issues.push(summary);
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }
  sharedChecks.push({
    id: "node_version",
    ok: true,
    summary: `node version satisfies ${requiredNodeRange}`
  });

  [details.stateRootWritable, details.configRootWritable, details.installRootWritable] = await Promise.all([
    isDirectoryWritable(paths.stateRoot),
    isDirectoryWritable(paths.configRoot),
    isDirectoryWritable(paths.installRoot)
  ]);

  if (!details.stateRootWritable) {
    const summary = `state root is not writable: ${paths.stateRoot}`;
    sharedChecks.push({ id: "state_root_writable", ok: false, summary });
    sharedIssues.push(summary);
    details.issues.push(summary);
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }
  sharedChecks.push({
    id: "state_root_writable",
    ok: true,
    summary: `state root writable: ${paths.stateRoot}`
  });

  if (!details.configRootWritable) {
    const summary = `config root is not writable: ${paths.configRoot}`;
    sharedChecks.push({ id: "config_root_writable", ok: false, summary });
    sharedIssues.push(summary);
    details.issues.push(summary);
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }
  sharedChecks.push({
    id: "config_root_writable",
    ok: true,
    summary: `config root writable: ${paths.configRoot}`
  });

  const serviceManager = await deps.detectServiceManager({
    commandExists: deps.commandExists
  });
  details.serviceManager = serviceManager.manager;
  details.serviceManagerHealth = serviceManager.health;
  sharedChecks.push({
    id: "service_manager",
    ok: serviceManager.manager !== "none",
    summary: serviceManager.manager === "none"
      ? "no supported service manager found"
      : `service manager available: ${serviceManager.manager}`
  });
  if (serviceManager.manager === "none") {
    sharedIssues.push(...serviceManager.issues.map((issue) => normalizeIssue(`service manager warning: ${issue}`)));
    details.issues.push(...serviceManager.issues.map((issue) => normalizeIssue(`service manager warning: ${issue}`)));
  }

  const resolvedCodexBin = await deps.resolveCommand(config.codexBin);
  if (resolvedCodexBin) {
    details.codexBinResolvedPath = resolvedCodexBin.resolvedPath;
  }
  if (!resolvedCodexBin) {
    sharedChecks.push({
      id: "codex_bin",
      ok: false,
      summary: "codex binary not found in PATH"
    });
    sharedIssues.push("codex binary not found in PATH");
    details.issues.push("codex binary not found in PATH");
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }
  sharedChecks.push({
    id: "codex_bin",
    ok: true,
    summary: `codex binary resolved: ${resolvedCodexBin.resolvedPath}`
  });

  const versionResult = await deps.runCommand(config.codexBin, ["--version"]);
  if (versionResult.exitCode !== 0) {
    const summary = versionResult.stderr || "failed to read codex version";
    sharedChecks.push({ id: "codex_version", ok: false, summary });
    sharedIssues.push(summary);
    details.issues.push(summary);
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }

  details.codexInstalled = true;
  details.codexVersion = versionResult.stdout;
  details.codexVersionSupported = isVersionAtLeast(versionResult.stdout, MIN_CODEX_VERSION);
  if (!details.codexVersionSupported) {
    const summary = `Codex version ${versionResult.stdout} is below required floor ${MIN_CODEX_VERSION.join(".")}`;
    sharedChecks.push({ id: "codex_version", ok: false, summary });
    sharedIssues.push(summary);
    details.issues.push(summary);
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }
  sharedChecks.push({
    id: "codex_version",
    ok: true,
    summary: `codex version supported: ${versionResult.stdout}`
  });

  const capabilitySummary = await deps.evaluateCapabilities({
    codexBin: config.codexBin,
    codexVersionText: versionResult.stdout,
    paths,
    runCommand: deps.runCommand
  });
  details.capabilityCheckPassed = capabilitySummary.ok;
  details.capabilityCheckSource = capabilitySummary.source;
  if (!capabilitySummary.ok) {
    sharedChecks.push({
      id: "app_server_capability_surface",
      ok: false,
      summary: capabilitySummary.issues.join("; ") || "capability check failed"
    });
    sharedIssues.push(...capabilitySummary.issues.map((issue) => normalizeIssue(issue)));
    details.issues.push(...capabilitySummary.issues.map((issue) => normalizeIssue(issue)));
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }
  sharedChecks.push({
    id: "app_server_capability_surface",
    ok: true,
    summary: `required app-server surface available (${capabilitySummary.source})`
  });

  const loginStatus = await deps.runCommand(config.codexBin, ["login", "status"]);
  const loginOutput = loginStatus.stdout || loginStatus.stderr;
  details.codexLoginStatus = loginOutput;
  details.codexAuthenticated = loginStatus.exitCode === 0 && loginOutput.includes("Logged in");

  if (!details.codexAuthenticated) {
    sharedChecks.push({
      id: "codex_login",
      ok: false,
      summary: "codex login status is not ready"
    });
    sharedIssues.push("codex login status is not ready");
    details.issues.push("codex login status is not ready");
    return finalizeFailure("codex_not_authenticated", details, store, persist);
  }
  sharedChecks.push({
    id: "codex_login",
    ok: true,
    summary: "codex login status is ready"
  });

  let appServer: AppServerLifecycle | null = null;

  try {
    appServer = deps.createAppServer({
      codexBin: config.codexBin,
      appServerLogPath: paths.appServerLogPath,
      logger,
      experimentalApi: true
    });
    await appServer.initializeAndProbe();
    details.appServerAvailable = true;
    sharedChecks.push({
      id: "app_server_runtime",
      ok: true,
      summary: "app-server initialized successfully"
    });
    if (config.voiceInputEnabled && config.voiceTranscriptionProvider !== "faster-whisper" && appServer.listModels) {
      try {
        details.voiceRealtimeSupported = await hasAudioCapableModel(appServer);
      } catch {
        details.voiceRealtimeSupported = false;
      }
    }
  } catch (error) {
    const summary = `${error}`;
    sharedChecks.push({
      id: "app_server_runtime",
      ok: false,
      summary
    });
    sharedIssues.push(summary);
    details.issues.push(summary);

    if (appServer) {
      await appServer.stop().catch(() => {});
    }

    return finalizeFailure("app_server_unavailable", details, store, persist);
  }

  if (
    config.voiceInputEnabled
    && (config.voiceTranscriptionProvider === "faster-whisper"
      ? !details.voiceLocalAvailable
      : !details.voiceOpenaiConfigured && !(details.voiceRealtimeSupported && details.voiceFfmpegAvailable))
  ) {
    details.issues.push("voice input is enabled but no usable transcription backend is available");
    await appServer.stop().catch(() => {});
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }

  let packReport = await (deps.runPackHealthCheck
    ? deps.runPackHealthCheck({
        pack,
        config,
        store,
        logger
      })
    : pack.healthChecks.run({
        config,
        store,
        logger
      }));
  if (config.activePack === "feishu") {
    const storedSnapshot = store.getReadinessSnapshot();
    if (storedSnapshot?.details.activePack === "feishu") {
      packReport = {
        ...packReport,
        ...buildFeishuSetupHealth({
          report: {
            ...packReport,
            metadata: mergeStoredFeishuSetupMetadata(packReport.metadata, storedSnapshot.details.packMetadata)
          },
          authorized: pack.authBinding.isBound(store)
        })
      };
    }
  }
  packChecks.push(...packReport.checks);
  packIssues.push(...packReport.issues.map((issue) => normalizeIssue(issue)));
  details.issues.push(...packReport.issues.map((issue) => normalizeIssue(issue)));
  details.packState = packReport.state;
  details.setupState = packReport.setupState ?? "complete";
  details.authorizedUserBound = pack.authBinding.isBound(store);
  details.packMetadata = {
    ...(details.packMetadata ?? {}),
    ...(packReport.metadata ?? {})
  };
  if (packReport.setupChecklist) {
    details.setupChecklist = [...packReport.setupChecklist];
  }

  if (packReport.state === "pack_unhealthy") {
    if (appServer) {
      await appServer.stop().catch(() => {});
    }
    return finalizeFailure("pack_unhealthy", details, store, persist);
  }

  const state = packReport.state === "awaiting_authorization" ? "awaiting_authorization" : "ready";
  const snapshot = buildSnapshot(state, details, appServer.pid);
  if (persist) {
    store.writeReadinessSnapshot(snapshot);
  }

  if (!(options.keepAppServer ?? false)) {
    await appServer.stop();
    return { snapshot, appServer: null };
  }

  return { snapshot, appServer: appServer as CodexAppServerClient };
}
