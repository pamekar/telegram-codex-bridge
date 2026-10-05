import type { TelegramInlineKeyboardMarkup } from "./telegram/api.js";
import type { JsonRpcRequestId } from "./codex/app-server.js";
import type { BridgePackName } from "./packs/names.js";
import type {
  PlatformBindingRef,
  PlatformUserRef
} from "./core/domain/binding.js";
import type {
  FailureReason,
  PendingInteractionKind,
  PendingInteractionState,
  RuntimeNoticeType,
  SessionStatus,
  TerminalDeliveryState,
  TerminalResultKind
} from "./core/domain/common.js";

export type {
  FailureReason,
  PendingInteractionKind,
  PendingInteractionState,
  RuntimeNoticeType,
  SessionStatus,
  TerminalDeliveryState,
  TerminalResultKind
} from "./core/domain/common.js";

export type BridgeReadinessState =
  | "ready"
  | "awaiting_authorization"
  | "codex_not_authenticated"
  | "app_server_unavailable"
  | "pack_unhealthy"
  | "bridge_unhealthy";

export type PackSetupState = "complete" | "incomplete";

export function isOperationalReadinessState(state: BridgeReadinessState): boolean {
  return state === "ready" || state === "awaiting_authorization";
}

export type RecentProjectSource = "mru" | "pin" | "scan" | "last_success";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SessionPlanMode = "default" | "plan";

export type UiLanguage = "zh" | "en";

export type RuntimeStatusField =
  | "model-name"
  | "model-with-reasoning"
  | "current-dir"
  | "project-root"
  | "git-branch"
  | "context-remaining"
  | "context-used"
  | "five-hour-limit"
  | "weekly-limit"
  | "codex-version"
  | "context-window-size"
  | "used-tokens"
  | "total-input-tokens"
  | "total-output-tokens"
  | "session-id"
  | "session_name"
  | "project_name"
  | "project_path"
  | "plan_mode"
  | "model_reasoning"
  | "thread_id"
  | "turn_id"
  | "blocked_reason"
  | "current_step"
  | "last_token_usage"
  | "total_token_usage"
  | "context_window"
  | "final_answer_ready";

export const CODEX_CLI_RUNTIME_STATUS_FIELDS: readonly RuntimeStatusField[] = [
  "model-name",
  "model-with-reasoning",
  "current-dir",
  "project-root",
  "git-branch",
  "context-remaining",
  "context-used",
  "five-hour-limit",
  "weekly-limit",
  "codex-version",
  "context-window-size",
  "used-tokens",
  "total-input-tokens",
  "total-output-tokens",
  "session-id"
] as const;

export const BRIDGE_EXTENSION_RUNTIME_STATUS_FIELDS: readonly RuntimeStatusField[] = [
  "session_name",
  "project_name",
  "project_path",
  "plan_mode",
  "model_reasoning",
  "thread_id",
  "turn_id",
  "blocked_reason",
  "current_step",
  "last_token_usage",
  "total_token_usage",
  "context_window",
  "final_answer_ready"
] as const;

export const ALL_RUNTIME_STATUS_FIELDS: readonly RuntimeStatusField[] = [
  ...CODEX_CLI_RUNTIME_STATUS_FIELDS,
  ...BRIDGE_EXTENSION_RUNTIME_STATUS_FIELDS
] as const;

export const DEFAULT_RUNTIME_STATUS_FIELDS: RuntimeStatusField[] = [];

export type TurnInputSourceKind = "voice";

export interface ReadinessDetails {
  activePack?: BridgePackName;
  codexInstalled: boolean;
  codexAuthenticated: boolean;
  appServerAvailable: boolean;
  packState?: "ready" | "awaiting_authorization" | "pack_unhealthy";
  setupState?: PackSetupState;
  authorizedUserBound: boolean;
  issues: string[];
  nodeVersion?: string;
  nodeVersionSupported?: boolean;
  codexVersion?: string;
  codexVersionSupported?: boolean;
  codexBinResolvedPath?: string;
  codexLoginStatus?: string;
  packMetadata?: Record<string, string | boolean | null | undefined>;
  systemdAvailable?: boolean;
  serviceManager?: "systemd" | "launchd" | "task_scheduler" | "none";
  serviceManagerHealth?: "ok" | "warning" | "error";
  stateRootWritable?: boolean;
  configRootWritable?: boolean;
  installRootWritable?: boolean;
  capabilityCheckPassed?: boolean;
  capabilityCheckSource?: "cache" | "generated_schema" | "unknown";
  voiceInputEnabled?: boolean;
  voiceOpenaiConfigured?: boolean;
  voiceLocalAvailable?: boolean;
  voiceFfmpegAvailable?: boolean;
  voiceFfmpegResolvedPath?: string;
  voiceRealtimeSupported?: boolean;
  sharedChecks?: Array<{
    id: string;
    ok: boolean;
    summary: string;
  }>;
  packChecks?: Array<{
    id: string;
    ok: boolean;
    summary: string;
    missingEnv?: string[] | undefined;
  }>;
  sharedIssues?: string[];
  packIssues?: string[];
  setupChecklist?: string[];
}

export interface ReadinessSnapshot {
  state: BridgeReadinessState;
  checkedAt: string;
  details: ReadinessDetails;
  appServerPid?: string | null;
}

export function isSetupComplete(snapshot: ReadinessSnapshot): boolean {
  return (snapshot.details.setupState ?? "complete") === "complete";
}

export function normalizeReadinessSnapshot(snapshot: ReadinessSnapshot): ReadinessSnapshot {
  const legacyState = snapshot.state as string;
  const legacyDetails = snapshot.details as ReadinessDetails & {
    telegramBotUsername?: string;
    telegramBotId?: string;
  };
  const packMetadata = {
    ...(snapshot.details.packMetadata ?? {})
  };

  if (legacyDetails.telegramBotUsername !== undefined && packMetadata.telegramBotUsername === undefined) {
    packMetadata.telegramBotUsername = legacyDetails.telegramBotUsername;
  }
  if (legacyDetails.telegramBotId !== undefined && packMetadata.telegramBotId === undefined) {
    packMetadata.telegramBotId = legacyDetails.telegramBotId;
  }

  return {
    ...snapshot,
    state: legacyState === "telegram_token_invalid" ? "pack_unhealthy" : snapshot.state,
    details: {
      ...snapshot.details,
      packState: snapshot.details.packState
        ?? (snapshot.state === "pack_unhealthy" || legacyState === "telegram_token_invalid"
          ? "pack_unhealthy"
          : snapshot.state === "ready"
            ? "ready"
            : "awaiting_authorization"),
      setupState: snapshot.details.setupState ?? "complete",
      packMetadata
    }
  };
}

export interface AuthorizedUserRow extends PlatformUserRef {
  /** @deprecated Use `userId`. */
  telegramUserId: string;
  /** @deprecated Use `username`. */
  telegramUsername: string | null;
  displayName: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

export interface PendingAuthorizationRow extends PlatformUserRef {
  chatId: string;
  /** @deprecated Use `userId`. */
  telegramUserId: string;
  /** @deprecated Use `chatId`. */
  telegramChatId: string;
  /** @deprecated Use `username`. */
  telegramUsername: string | null;
  displayName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  expired: boolean;
}

export interface ChatBindingRow extends PlatformBindingRef {
  /** @deprecated Use `chatId`. */
  telegramChatId: string;
  /** @deprecated Use `userId`. */
  telegramUserId: string;
  activeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstallManifest {
  version: string;
  sourceRoot: string | null;
  installedAt: string;
  activePack?: BridgePackName | null;
  installSource?: InstallSourceMetadata | null;
}

export interface GitHubArchiveInstallSource {
  kind: "github-archive";
  repoOwner: string;
  repoName: string;
  ref: string;
  refType: "branch" | "tag";
}

export type InstallSourceMetadata = GitHubArchiveInstallSource;

export interface RuntimeNotice {
  key: string;
  chatId: string;
  type: RuntimeNoticeType;
  message: string;
  parseMode?: "HTML" | null;
  replyMarkup?: TelegramInlineKeyboardMarkup | null;
  sessionId?: string | null;
  turnId?: string | null;
  createdAt: string;
}

export interface TerminalResultViewRow {
  answerId: string;
  chatId: string;
  deliveryMessageId: number | null;
  sessionId: string;
  threadId: string;
  turnId: string;
  kind: TerminalResultKind;
  deliveryState: TerminalDeliveryState;
  previewHtml: string;
  pages: string[];
  primaryActionConsumed: boolean;
  createdAt: string;
}

/** @deprecated Use `TerminalResultViewRow`. */
export interface FinalAnswerViewRow extends TerminalResultViewRow {}

export interface CurrentSessionCardRow {
  chatId: string;
  messageId: number | null;
  sessionId: string;
  updatedAt: string;
}

export interface RuntimeCardPreferencesRow {
  key: "global";
  fields: RuntimeStatusField[];
  updatedAt: string;
}

export interface CommandPanelPreferencesRow {
  chatId: string;
  commands: string[];
  updatedAt: string;
}

export interface UiLanguageRow {
  key: "global";
  language: UiLanguage;
  updatedAt: string;
}

export interface TurnInputSourceRow {
  threadId: string;
  turnId: string;
  sourceKind: TurnInputSourceKind;
  transcript: string;
  createdAt: string;
}

export interface PendingInteractionRow {
  interactionId: string;
  chatId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  requestId: JsonRpcRequestId;
  requestMethod: string;
  interactionKind: PendingInteractionKind;
  state: PendingInteractionState;
  promptJson: string;
  responseJson: string | null;
  messageId: number | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  errorReason: string | null;
}

export interface PendingInteractionSummary {
  interactionId: string;
  requestMethod: string;
  interactionKind: PendingInteractionKind;
  state: PendingInteractionState;
  awaitingText: boolean;
}

export type SessionDisplayNameSource = "auto" | "manual";

export interface SessionRow {
  sessionId: string;
  chatId: string;
  /** @deprecated Use `chatId`. */
  telegramChatId: string;
  threadId: string | null;
  selectedModel: string | null;
  selectedReasoningEffort: ReasoningEffort | null;
  planMode: boolean;
  needsDefaultCollaborationModeReset: boolean;
  displayName: string;
  displayNameSource: SessionDisplayNameSource;
  projectName: string;
  projectAlias: string | null;
  projectPath: string;
  status: SessionStatus;
  failureReason: FailureReason | null;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  lastUsedAt: string;
  lastTurnId: string | null;
  lastTurnStatus: string | null;
}

export interface RecentProjectRow {
  projectPath: string;
  projectName: string;
  projectAlias: string | null;
  lastUsedAt: string;
  pinned: boolean;
  lastSessionId: string | null;
  lastSuccessAt: string | null;
  source: RecentProjectSource;
}

export interface ProjectScanCacheRow {
  projectPath: string;
  projectName: string;
  scanRoot: string;
  confidence: number;
  detectedMarkers: string[];
  lastScannedAt: string;
  existsNow: boolean;
}

export interface SessionProjectStatsRow {
  projectPath: string;
  projectName: string;
  sessionCount: number;
  lastUsedAt: string | null;
}

export interface ProjectCandidate {
  projectKey: string;
  projectPath: string;
  projectName: string;
  projectAlias: string | null;
  displayName: string;
  pathLabel: string;
  group: "pinned" | "recent" | "discovered";
  isRecent: boolean;
  score: number;
  pinned: boolean;
  hasExistingSession: boolean;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  accessible: boolean;
  fromScan: boolean;
  detectedMarkers: string[];
}

export interface ProjectPickerGroup {
  key: "pinned" | "recent";
  title: string;
  candidates: ProjectCandidate[];
}

export interface ProjectPickerResult {
  title: string;
  emptyText: string | null;
  noticeLines: string[];
  groups: ProjectPickerGroup[];
  partial: boolean;
  allRootsFailed: boolean;
  projectMap: Map<string, ProjectCandidate>;
}
