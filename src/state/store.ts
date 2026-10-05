import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

import { BridgeError } from "../errors.js";
import type { JsonRpcRequestId } from "../codex/app-server.js";
import type { BridgePlatform } from "../core/domain/binding.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { nowIso } from "../util/time.js";
import {
  applyFeishuSetupToSnapshot,
  resetFeishuSetupCycle
} from "../packs/feishu/setup.js";
import type {
  AuthorizedUserRow,
  BridgeReadinessState,
  ChatBindingRow,
  CommandPanelPreferencesRow,
  CurrentSessionCardRow,
  FailureReason,
  PendingInteractionKind,
  PendingInteractionRow,
  PendingInteractionState,
  PendingAuthorizationRow,
  ProjectScanCacheRow,
  ReadinessSnapshot,
  RecentProjectRow,
  ReasoningEffort,
  RuntimeCardPreferencesRow,
  RuntimeStatusField,
  RuntimeNotice,
  SessionProjectStatsRow,
  SessionDisplayNameSource,
  SessionRow,
  SessionStatus,
  TerminalResultViewRow,
  UiLanguage,
  TurnInputSourceKind,
  TurnInputSourceRow
} from "../types.js";
import { resolveAutoSessionTitle } from "../util/session-title.js";
import {
  appliedTableExists,
  buildStateStoreFailure,
  clearStateStoreFailure,
  getStateStoreFailureStage,
  logStateStoreOpenFailure,
  openInitializedDatabase,
  persistStateStoreFailure,
  withStateStoreFailureStage
} from "./store-open.js";
import {
  createStorePendingInteractions,
  type StorePendingInteractions
} from "./store-pending-interactions.js";
import {
  createStoreAuth,
  type StoreAuth
} from "./store-auth.js";
import {
  choosePreferredActiveSessionId
} from "./store-records.js";
import {
  createStoreRuntimeArtifacts,
  type StoreRuntimeArtifacts
} from "./store-runtime-artifacts.js";
import {
  createStoreSessions,
  type StoreSessions
} from "./store-sessions.js";

export type StateStoreOpenStage =
  | "open_db"
  | "initialize_schema"
  | "verify_integrity"
  | "normalize_active_sessions";

export type StateStoreFailureClassification =
  | "transient_open_failure"
  | "integrity_failure"
  | "schema_failure";

export interface StateStoreFailureRecord {
  detectedAt: string;
  dbPath: string;
  stage: StateStoreOpenStage;
  classification: StateStoreFailureClassification;
  error: string;
  recommendedAction: string;
}

export class StateStoreOpenError extends BridgeError {
  readonly failure: StateStoreFailureRecord;

  constructor(failure: StateStoreFailureRecord) {
    super(
      `state store open failed (${failure.classification} at ${failure.stage}): ${failure.error}`,
      failure.classification === "transient_open_failure" ? "transient" : "fatal"
    );
    this.name = "StateStoreOpenError";
    this.failure = failure;
  }
}

export { readStateStoreFailure } from "./store-open.js";

function isTransientSqliteLockError(error: unknown): boolean {
  const message = `${error}`.toLowerCase();
  return message.includes("database is locked")
    || message.includes("database busy")
    || message.includes("sqlite_busy")
    || message.includes("busy");
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class BridgeStateStore {
  private readonly auth: StoreAuth;
  private readonly runtimeArtifacts: StoreRuntimeArtifacts;
  private readonly pendingInteractions: StorePendingInteractions;
  private readonly sessions: StoreSessions;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly logger: Logger,
  readonly recoveredFromCorruption: boolean
  ) {
    this.auth = createStoreAuth(db);
    this.runtimeArtifacts = createStoreRuntimeArtifacts(db);
    this.pendingInteractions = createStorePendingInteractions(db);
    this.sessions = createStoreSessions(db, {
      auth: this.auth
    });
  }

  private updateReadinessSnapshotAuthorization(
    snapshot: ReadinessSnapshot,
    platform: BridgePlatform | undefined,
    authorized: boolean,
    timestamp: string
  ): ReadinessSnapshot {
    const affectsActivePack = platform === undefined
      || snapshot.details.activePack === undefined
      || snapshot.details.activePack === platform;
    if (!affectsActivePack) {
      return snapshot;
    }

    const activePack = platform ?? snapshot.details.activePack ?? "telegram";
    const bindingCheckId = `${activePack}_authorization_binding`;
    const bindingSummary = authorized
      ? `${activePack} authorization is bound`
      : `${activePack} authorization is pending`;
    const previousPackChecks = snapshot.details.packChecks ?? [];
    const hadBindingCheck = previousPackChecks.some((check) => check.id === bindingCheckId);
    const packChecks = hadBindingCheck
      ? previousPackChecks.map((check) => check.id === bindingCheckId
        ? { ...check, ok: authorized, summary: bindingSummary }
        : check)
      : [
        ...previousPackChecks,
        {
          id: bindingCheckId,
          ok: authorized,
          summary: bindingSummary
        }
      ];
    const packState: "ready" | "awaiting_authorization" | "pack_unhealthy" =
      snapshot.state === "pack_unhealthy" || snapshot.details.packState === "pack_unhealthy"
      ? "pack_unhealthy"
      : authorized
        ? "ready"
        : "awaiting_authorization";
    const packIssues = packChecks.filter((check) => !check.ok).map((check) => check.summary);
    const sharedIssues = snapshot.details.sharedIssues
      ?? snapshot.details.issues.filter((issue) =>
        !previousPackChecks.some((check) => check.summary === issue)
      );

    const nextState: BridgeReadinessState = packState === "pack_unhealthy"
      ? "pack_unhealthy"
      : !snapshot.details.codexAuthenticated
        ? "codex_not_authenticated"
        : !snapshot.details.appServerAvailable
          ? "app_server_unavailable"
          : authorized
            ? "ready"
            : "awaiting_authorization";
    const nextSnapshot: ReadinessSnapshot = {
      ...snapshot,
      state: nextState,
      checkedAt: timestamp,
      details: {
        ...snapshot.details,
        activePack,
        packState,
        authorizedUserBound: authorized,
        packChecks,
        packIssues,
        sharedIssues,
        issues: [...sharedIssues, ...packIssues]
      }
    };

    if (activePack !== "feishu") {
      return nextSnapshot;
    }

    return authorized
      ? applyFeishuSetupToSnapshot(nextSnapshot)
      : resetFeishuSetupCycle(nextSnapshot, timestamp);
  }

  static async open(paths: BridgePaths, logger: Logger): Promise<BridgeStateStore> {
    const retryDelaysMs = [150, 400, 900];

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        const store = this.openInitializedStore(paths.dbPath, logger, false);
        await clearStateStoreFailure(paths);
        return store;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          try {
            // First-run installs may be missing the state directory even though creating a new DB is safe.
            await mkdir(dirname(paths.dbPath), { recursive: true });
            const store = this.openInitializedStore(paths.dbPath, logger, false);
            await clearStateStoreFailure(paths);
            return store;
          } catch (retryError) {
            const retryFailure = buildStateStoreFailure(
              paths.dbPath,
              getStateStoreFailureStage(retryError),
              retryError
            );
            if (retryFailure.classification === "transient_open_failure" && attempt < retryDelaysMs.length) {
              const delayMs = retryDelaysMs[attempt];
              if (delayMs !== undefined) {
                await sleep(delayMs);
              }
              continue;
            }
            await persistStateStoreFailure(paths, retryFailure, logger);
            await logStateStoreOpenFailure(logger, retryFailure);
            throw new StateStoreOpenError(retryFailure);
          }
        }

        const failure = buildStateStoreFailure(paths.dbPath, getStateStoreFailureStage(error), error);
        if (failure.classification === "transient_open_failure" && isTransientSqliteLockError(error) && attempt < retryDelaysMs.length) {
          const delayMs = retryDelaysMs[attempt];
          if (delayMs !== undefined) {
            await sleep(delayMs);
          }
          continue;
        }

        // Any non-ENOENT failure must preserve the existing database and stop the service cold.
        await persistStateStoreFailure(paths, failure, logger);
        await logStateStoreOpenFailure(logger, failure);
        throw new StateStoreOpenError(failure);
      }
    }

    const failure = buildStateStoreFailure(paths.dbPath, "open_db", "state store open retries exhausted");
    await persistStateStoreFailure(paths, failure, logger);
    await logStateStoreOpenFailure(logger, failure);
    throw new StateStoreOpenError(failure);
  }

  private static openInitializedStore(
    dbPath: string,
    logger: Logger,
    recoveredFromCorruption: boolean
  ): BridgeStateStore {
    const db = openInitializedDatabase(dbPath);

    try {
      const store = new BridgeStateStore(db, logger, recoveredFromCorruption);
      withStateStoreFailureStage("normalize_active_sessions", () => store.normalizeAllActiveSessions());
      return store;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Ignore close failures while surfacing the original open error.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private normalizeAllActiveSessions(): void {
    const bindings = this.auth.listChatBindings();
    for (const binding of bindings) {
      this.sessions.normalizeActiveSession(binding.chatId);
    }
  }

  getAuthorizedUser(platform?: BridgePlatform): AuthorizedUserRow | null {
    return this.auth.getAuthorizedUser(platform);
  }

  getChatBinding(chatId: string, platform?: BridgePlatform): ChatBindingRow | null {
    return this.auth.getChatBinding(chatId, platform);
  }

  listChatBindings(platform?: BridgePlatform): ChatBindingRow[] {
    return this.auth.listChatBindings(platform);
  }

  listPendingAuthorizations(options?: {
    includeExpired?: boolean;
    platform?: BridgePlatform;
  }): PendingAuthorizationRow[] {
    return this.auth.listPendingAuthorizations(options);
  }

  upsertPendingAuthorization(candidate: {
    platform?: BridgePlatform;
    userId?: string;
    telegramUserId?: string;
    chatId?: string;
    telegramChatId?: string;
    username?: string | null;
    telegramUsername?: string | null;
    displayName: string | null;
  }): void {
    this.auth.upsertPendingAuthorization(candidate);
  }

  confirmPendingAuthorization(candidate: PendingAuthorizationRow): void {
    if (candidate.expired) {
      throw new Error("pending authorization candidate expired; ask the user to message the bot again");
    }

    const timestamp = nowIso();
    const previousSnapshot = this.getReadinessSnapshot();
    this.db.exec("BEGIN IMMEDIATE");

    try {
      const existingBindings = this.auth.listChatBindingsByUserId(candidate.userId, candidate.platform);
      const previousChatIds = existingBindings.map((binding) => binding.chatId);
      const migratedActiveSessionId = choosePreferredActiveSessionId(existingBindings);

      this.auth.saveAuthorizedUser({
        platform: candidate.platform,
        userId: candidate.userId,
        username: candidate.username,
        displayName: candidate.displayName,
        firstSeenAt: candidate.firstSeenAt,
        updatedAt: timestamp
      });

      if (previousChatIds.length > 0) {
        this.sessions.rebindSessionsChatIds(candidate.chatId, previousChatIds);
        this.runtimeArtifacts.rebindRuntimeNoticesChatIds(candidate.chatId, previousChatIds);
        this.runtimeArtifacts.rebindCommandPanelPreferencesChatIds(candidate.chatId, previousChatIds);
        this.runtimeArtifacts.rebindCurrentSessionCardsChatIds(candidate.chatId, previousChatIds);
        this.runtimeArtifacts.rebindTerminalResultViewsChatIds(candidate.chatId, previousChatIds);

        if (appliedTableExists(this.db, "pending_interaction")) {
          this.pendingInteractions.rebindPendingInteractionsChatIds(candidate.chatId, previousChatIds);
        }

        this.auth.deleteChatBindingsByUserId(candidate.userId, candidate.platform);
      }

      this.auth.replaceChatBinding({
        platform: candidate.platform,
        chatId: candidate.chatId,
        userId: candidate.userId,
        activeSessionId: migratedActiveSessionId,
        createdAt: timestamp,
        updatedAt: timestamp
      });

      this.sessions.normalizeActiveSession(candidate.chatId);

      this.auth.clearPendingAuthorizations(candidate.platform);

      if (previousSnapshot) {
        this.writeReadinessSnapshot(
          this.updateReadinessSnapshotAuthorization(previousSnapshot, candidate.platform, true, timestamp)
        );
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearAuthorization(platform?: BridgePlatform): void {
    const previousSnapshot = this.getReadinessSnapshot();
    this.db.exec("BEGIN IMMEDIATE");

    try {
      const bindings = platform ? this.auth.listChatBindings(platform) : this.auth.listChatBindings();

      this.auth.clearAuthorizedUsers(platform);
      this.auth.clearChatBindings(platform);
      this.auth.clearPendingAuthorizations(platform);

      if (platform) {
        for (const binding of bindings) {
          this.runtimeArtifacts.deleteCurrentSessionCard(binding.chatId);
          for (const notice of this.runtimeArtifacts.listRuntimeNotices(binding.chatId)) {
            this.runtimeArtifacts.clearRuntimeNotice(notice.key);
          }
          for (const result of this.runtimeArtifacts.listTerminalResultViews(binding.chatId)) {
            this.runtimeArtifacts.deleteTerminalResultView(result.answerId);
          }
          if (appliedTableExists(this.db, "pending_interaction")) {
            this.pendingInteractions.clearPendingInteractionsByChat(binding.chatId);
          }
        }
      } else {
        this.runtimeArtifacts.clearAllCurrentSessionCards();
        this.runtimeArtifacts.clearAllFinalAnswerViews();
        if (appliedTableExists(this.db, "pending_interaction")) {
          this.pendingInteractions.clearAllPendingInteractions();
        }
      }

      if (previousSnapshot) {
        this.writeReadinessSnapshot(
          this.updateReadinessSnapshotAuthorization(previousSnapshot, platform, false, nowIso())
        );
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markRunningSessionsFailed(reason: FailureReason): number {
    return this.sessions.markRunningSessionsFailed(reason);
  }

  listRunningSessions(): SessionRow[] {
    return this.sessions.listRunningSessions();
  }

  markRunningSessionsFailedWithNotices(reason: FailureReason): RuntimeNotice[] {
    const runningSessions = this.sessions.listRunningSessions();

    if (runningSessions.length === 0) {
      return [];
    }

    const timestamp = nowIso();
    this.db.exec("BEGIN");

    try {
      this.sessions.markRunningSessionsFailedAt(reason, timestamp);

      const notices = runningSessions.map((session) => {
        const notice: RuntimeNotice = {
          key: `restart:${session.sessionId}:${timestamp}`,
          chatId: session.chatId,
          type: "bridge_restart_recovery",
          message: "Bridge service restarted. Running operation status unknown. Check session status and retry.",
          createdAt: timestamp
        };

        return notice;
      });
      this.runtimeArtifacts.upsertRuntimeNotices(notices);

      if (appliedTableExists(this.db, "pending_interaction")) {
        this.pendingInteractions.failPendingInteractionsForSessionIds(
          runningSessions.map((session) => session.sessionId),
          timestamp,
          "bridge_restart"
        );
      }

      this.db.exec("COMMIT");
      return notices;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSessions(chatId: string, limitOrOptions?: number | { archived?: boolean; limit?: number }): SessionRow[] {
    return this.sessions.listSessions(chatId, limitOrOptions);
  }

  getSessionById(sessionId: string): SessionRow | null {
    return this.sessions.getSessionById(sessionId);
  }

  getSessionByThreadId(threadId: string): SessionRow | null {
    return this.sessions.getSessionByThreadId(threadId);
  }

  listSessionsWithThreads(): SessionRow[] {
    return this.sessions.listSessionsWithThreads();
  }

  getActiveSession(chatId: string): SessionRow | null {
    return this.sessions.getActiveSession(chatId);
  }

  createSession(options: {
    chatId: string;
    projectName: string;
    projectPath: string;
    displayName?: string;
    displayNameSource?: SessionDisplayNameSource;
    selectedModel?: string | null;
    selectedReasoningEffort?: ReasoningEffort | null;
    planMode?: boolean;
    needsDefaultCollaborationModeReset?: boolean;
    threadId?: string | null;
    lastTurnId?: string | null;
    lastTurnStatus?: string | null;
  }): SessionRow {
    return this.sessions.createSession(options);
  }

  setActiveSession(chatId: string, sessionId: string): void {
    this.sessions.setActiveSession(chatId, sessionId);
  }

  archiveSession(sessionId: string): SessionRow | null {
    return this.sessions.archiveSession(sessionId);
  }

  unarchiveSession(sessionId: string): SessionRow | null {
    return this.sessions.unarchiveSession(sessionId);
  }

  renameSession(sessionId: string, displayName: string): void {
    this.sessions.renameSession(sessionId, displayName);
  }

  autoRenameSession(sessionId: string, displayName: string): boolean {
    return this.sessions.autoRenameSession(sessionId, displayName);
  }

  syncSessionTitleFromThread(
    threadId: string,
    options: {
      name?: string | null | undefined;
      preview?: string | null | undefined;
    }
  ): boolean {
    const session = this.getSessionByThreadId(threadId);
    if (!session) {
      return false;
    }

    const title = resolveAutoSessionTitle({
      threadName: options.name,
      preview: options.preview
    });
    if (!title) {
      return false;
    }

    return this.sessions.autoRenameSession(session.sessionId, title);
  }

  pinProject(options: {
    projectPath: string;
    projectName: string;
    sessionId: string | null;
  }): void {
    this.sessions.pinProject(options);
  }

  isProjectPinned(projectPath: string): boolean {
    return this.sessions.isProjectPinned(projectPath);
  }

  getRecentProjectByPath(projectPath: string): RecentProjectRow | null {
    return this.sessions.getRecentProjectByPath(projectPath);
  }

  listRecentProjects(): RecentProjectRow[] {
    return this.sessions.listRecentProjects();
  }

  setProjectAlias(options: {
    projectPath: string;
    projectName: string;
    projectAlias: string;
    sessionId: string | null;
  }): void {
    this.sessions.setProjectAlias(options);
  }

  clearProjectAlias(projectPath: string): void {
    this.sessions.clearProjectAlias(projectPath);
  }

  listPinnedProjectPaths(): string[] {
    return this.sessions.listPinnedProjectPaths();
  }

  listProjectScanCache(): ProjectScanCacheRow[] {
    return this.sessions.listProjectScanCache();
  }

  listSessionProjectStats(): SessionProjectStatsRow[] {
    return this.sessions.listSessionProjectStats();
  }

  upsertProjectScanCandidates(
    candidates: Array<{
      projectPath: string;
      projectName: string;
      scanRoot: string;
      confidence: number;
      detectedMarkers: string[];
      existsNow: boolean;
    }>
  ): void {
    this.sessions.upsertProjectScanCandidates(candidates);
  }

  markProjectScanCandidateMissing(projectPath: string): void {
    this.sessions.markProjectScanCandidateMissing(projectPath);
  }

  updateSessionThreadId(sessionId: string, threadId: string | null): void {
    this.sessions.updateSessionThreadId(sessionId, threadId);
  }

  setSessionSelectedModel(sessionId: string, selectedModel: string | null): void {
    this.sessions.setSessionSelectedModel(sessionId, selectedModel);
  }

  setSessionSelectedReasoningEffort(sessionId: string, selectedReasoningEffort: ReasoningEffort | null): void {
    this.sessions.setSessionSelectedReasoningEffort(sessionId, selectedReasoningEffort);
  }

  setSessionPlanMode(sessionId: string, planMode: boolean): void {
    this.sessions.setSessionPlanMode(sessionId, planMode);
  }

  clearSessionDefaultCollaborationModeReset(sessionId: string): void {
    this.sessions.clearSessionDefaultCollaborationModeReset(sessionId);
  }

  updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    options?: {
      failureReason?: FailureReason | null;
      lastTurnId?: string | null;
      lastTurnStatus?: string | null;
    }
  ): void {
    this.sessions.updateSessionStatus(sessionId, status, options);
  }

  markSessionSuccessful(sessionId: string): void {
    this.sessions.markSessionSuccessful(sessionId);
  }

  listRuntimeNotices(chatId: string): RuntimeNotice[] {
    return this.runtimeArtifacts.listRuntimeNotices(chatId);
  }

  countRuntimeNotices(): number {
    return this.runtimeArtifacts.countRuntimeNotices();
  }

  clearRuntimeNotice(key: string): void {
    this.runtimeArtifacts.clearRuntimeNotice(key);
  }

  createRuntimeNotice(options: {
    key?: string;
    chatId: string;
    type: RuntimeNotice["type"];
    message: string;
    parseMode?: RuntimeNotice["parseMode"];
    replyMarkup?: RuntimeNotice["replyMarkup"];
    sessionId?: string | null;
    turnId?: string | null;
  }): RuntimeNotice {
    return this.runtimeArtifacts.createRuntimeNotice(options);
  }

  listNoticeChatIds(): string[] {
    return this.runtimeArtifacts.listNoticeChatIds();
  }

  getRuntimeCardPreferences(): RuntimeCardPreferencesRow {
    return this.runtimeArtifacts.getRuntimeCardPreferences();
  }

  setRuntimeCardPreferences(fields: RuntimeStatusField[]): RuntimeCardPreferencesRow {
    return this.runtimeArtifacts.setRuntimeCardPreferences(fields);
  }

  getUiLanguage(): UiLanguage {
    return this.runtimeArtifacts.getUiLanguage();
  }

  setUiLanguage(language: UiLanguage): UiLanguage {
    return this.runtimeArtifacts.setUiLanguage(language);
  }

  getCommandPanelPreferences(chatId: string): CommandPanelPreferencesRow | null {
    return this.runtimeArtifacts.getCommandPanelPreferences(chatId);
  }

  setCommandPanelPreferences(chatId: string, commands: string[]): CommandPanelPreferencesRow {
    return this.runtimeArtifacts.setCommandPanelPreferences(chatId, commands);
  }

  deleteCommandPanelPreferences(chatId: string): void {
    this.runtimeArtifacts.deleteCommandPanelPreferences(chatId);
  }

  getCurrentSessionCard(chatId: string): CurrentSessionCardRow | null {
    return this.runtimeArtifacts.getCurrentSessionCard(chatId);
  }

  upsertCurrentSessionCard(options: {
    chatId: string;
    messageId?: number | null;
    sessionId: string;
  }): CurrentSessionCardRow {
    return this.runtimeArtifacts.upsertCurrentSessionCard(options);
  }

  deleteCurrentSessionCard(chatId: string): void {
    this.runtimeArtifacts.deleteCurrentSessionCard(chatId);
  }

  saveTerminalResultView(options: {
    answerId?: string;
    chatId: string;
    deliveryMessageId?: number | null;
    sessionId: string;
    threadId: string;
    turnId: string;
    kind?: TerminalResultViewRow["kind"];
    deliveryState?: TerminalResultViewRow["deliveryState"];
    previewHtml: string;
    pages: string[];
    primaryActionConsumed?: boolean;
  }): TerminalResultViewRow {
    return this.runtimeArtifacts.saveTerminalResultView(options);
  }

  getTerminalResultView(answerId: string, chatId: string): TerminalResultViewRow | null {
    return this.runtimeArtifacts.getTerminalResultView(answerId, chatId);
  }

  listTerminalResultViews(chatId: string): TerminalResultViewRow[] {
    return this.runtimeArtifacts.listTerminalResultViews(chatId);
  }

  setTerminalResultMessageId(answerId: string, messageId: number): void {
    this.runtimeArtifacts.setTerminalResultMessageId(answerId, messageId);
  }

  setTerminalResultDeliveryState(answerId: string, deliveryState: TerminalResultViewRow["deliveryState"]): void {
    this.runtimeArtifacts.setTerminalResultDeliveryState(answerId, deliveryState);
  }

  setTerminalResultPrimaryActionConsumed(answerId: string, consumed: boolean): void {
    this.runtimeArtifacts.setTerminalResultPrimaryActionConsumed(answerId, consumed);
  }

  deleteTerminalResultView(answerId: string): void {
    this.runtimeArtifacts.deleteTerminalResultView(answerId);
  }

  saveFinalAnswerView(options: {
    answerId?: string;
    chatId: string;
    deliveryMessageId?: number | null;
    sessionId: string;
    threadId: string;
    turnId: string;
    kind?: TerminalResultViewRow["kind"];
    deliveryState?: TerminalResultViewRow["deliveryState"];
    previewHtml: string;
    pages: string[];
    primaryActionConsumed?: boolean;
  }): TerminalResultViewRow {
    return this.saveTerminalResultView(options);
  }

  getFinalAnswerView(answerId: string, chatId: string): TerminalResultViewRow | null {
    return this.getTerminalResultView(answerId, chatId);
  }

  listFinalAnswerViews(chatId: string): TerminalResultViewRow[] {
    return this.listTerminalResultViews(chatId);
  }

  setFinalAnswerMessageId(answerId: string, messageId: number): void {
    this.setTerminalResultMessageId(answerId, messageId);
  }

  setFinalAnswerDeliveryState(answerId: string, deliveryState: TerminalResultViewRow["deliveryState"]): void {
    this.setTerminalResultDeliveryState(answerId, deliveryState);
  }

  setFinalAnswerPrimaryActionConsumed(answerId: string, consumed: boolean): void {
    this.setTerminalResultPrimaryActionConsumed(answerId, consumed);
  }

  deleteFinalAnswerView(answerId: string): void {
    this.deleteTerminalResultView(answerId);
  }

  saveTurnInputSource(options: {
    threadId: string;
    turnId: string;
    sourceKind: TurnInputSourceKind;
    transcript: string;
  }): TurnInputSourceRow {
    return this.runtimeArtifacts.saveTurnInputSource(options);
  }

  getTurnInputSource(threadId: string, turnId: string): TurnInputSourceRow | null {
    return this.runtimeArtifacts.getTurnInputSource(threadId, turnId);
  }

  createPendingInteraction(options: {
    interactionId?: string;
    chatId: string;
    sessionId: string;
    threadId: string;
    turnId: string;
    requestId: JsonRpcRequestId;
    requestMethod: string;
    interactionKind: PendingInteractionKind;
    state?: PendingInteractionState;
    promptJson: string;
    responseJson?: string | null;
    messageId?: number | null;
    errorReason?: string | null;
  }): PendingInteractionRow {
    return this.pendingInteractions.createPendingInteraction(options);
  }

  getPendingInteraction(interactionId: string, chatId?: string): PendingInteractionRow | null {
    return this.pendingInteractions.getPendingInteraction(interactionId, chatId);
  }

  listPendingInteractionsByRequest(threadId: string, requestId: JsonRpcRequestId): PendingInteractionRow[] {
    return this.pendingInteractions.listPendingInteractionsByRequest(threadId, requestId);
  }

  listPendingInteractionsByChat(
    chatId: string,
    states?: PendingInteractionState[]
  ): PendingInteractionRow[] {
    return this.pendingInteractions.listPendingInteractionsByChat(chatId, states);
  }

  listPendingInteractionsByTurn(threadId: string, turnId: string): PendingInteractionRow[] {
    return this.pendingInteractions.listPendingInteractionsByTurn(threadId, turnId);
  }

  listUnresolvedPendingInteractions(): PendingInteractionRow[] {
    return this.pendingInteractions.listUnresolvedPendingInteractions();
  }

  listPendingInteractionsForRunningSessions(): PendingInteractionRow[] {
    return this.pendingInteractions.listPendingInteractionsForRunningSessions();
  }

  setPendingInteractionMessageId(interactionId: string, messageId: number): void {
    this.pendingInteractions.setPendingInteractionMessageId(interactionId, messageId);
  }

  savePendingInteractionDraftResponse(
    interactionId: string,
    state: PendingInteractionState,
    responseJson: string | null
  ): void {
    this.pendingInteractions.savePendingInteractionDraftResponse(interactionId, state, responseJson);
  }

  markPendingInteractionAwaitingText(interactionId: string, responseJson?: string | null): void {
    this.pendingInteractions.markPendingInteractionAwaitingText(interactionId, responseJson);
  }

  markPendingInteractionPending(interactionId: string, responseJson?: string | null): void {
    this.pendingInteractions.markPendingInteractionPending(interactionId, responseJson);
  }

  markPendingInteractionAnswered(interactionId: string, responseJson: string): void {
    this.pendingInteractions.markPendingInteractionAnswered(interactionId, responseJson);
  }

  markPendingInteractionCanceled(
    interactionId: string,
    responseJson?: string | null,
    reason?: string | null
  ): void {
    this.pendingInteractions.markPendingInteractionCanceled(interactionId, responseJson, reason);
  }

  markPendingInteractionFailed(interactionId: string, reason: string): void {
    this.pendingInteractions.markPendingInteractionFailed(interactionId, reason);
  }

  markPendingInteractionExpired(interactionId: string, reason: string): void {
    this.pendingInteractions.markPendingInteractionExpired(interactionId, reason);
  }

  expirePendingInteractionsForTurn(threadId: string, turnId: string, reason: string): number {
    return this.pendingInteractions.expirePendingInteractionsForTurn(threadId, turnId, reason);
  }

  writeReadinessSnapshot(snapshot: ReadinessSnapshot): void {
    this.runtimeArtifacts.writeReadinessSnapshot(snapshot);
  }

  getReadinessSnapshot(): ReadinessSnapshot | null {
    return this.runtimeArtifacts.getReadinessSnapshot();
  }
}
