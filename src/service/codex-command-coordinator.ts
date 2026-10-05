import type { CodexAppServerClient, UserInput } from "../codex/app-server.js";
import {
  createRollbackConfirmView,
  createRollbackPickerView
} from "../core/workflow/runtime-workflow.js";
import type { BridgeStateStore } from "../state/store.js";
import type { TelegramInlineKeyboardMarkup } from "../telegram/api.js";
import {
  buildModelPickerClosedText,
  buildModelPickerMessage,
  buildReasoningEffortPickerMessage,
  buildRollbackClosedMessage,
  buildRollbackConfirmMessage,
  buildRollbackPickerMessage,
  formatSessionModelReasoningConfig,
  type RollbackTargetView
} from "../telegram/ui.js";
import type { ReasoningEffort, SessionRow } from "../types.js";
import { normalizeAndTruncate, normalizeWhitespace, truncateText, summarizeTextPreview, splitStructuredInputCommand, HISTORY_TEXT_LIMIT } from "../util/text.js";
import { asRecord, getArray, getString } from "../util/untyped.js";

interface ReviewCommandArgs {
  delivery?: "inline" | "detached";
  target:
    | { type: "uncommittedChanges" }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title?: string | null }
    | { type: "custom"; instructions: string };
}

interface ThreadMetadataUpdate {
  branch?: string | null;
  sha?: string | null;
  originUrl?: string | null;
}

interface CodexCommandCoordinatorDeps {
  getStore: () => BridgeStateStore | null;
  ensureAppServerAvailable: () => Promise<CodexAppServerClient>;
  startFreshThreadForClear: (session: SessionRow) => Promise<Awaited<ReturnType<CodexAppServerClient["startThread"]>>>;
  fetchAllModels: () => Promise<
    NonNullable<Awaited<ReturnType<CodexAppServerClient["listModels"]>>["data"]>
  >;
  fetchAllApps: (
    threadId?: string
  ) => Promise<NonNullable<Awaited<ReturnType<CodexAppServerClient["listApps"]>>["data"]>>;
  fetchAllMcpServerStatuses: () => Promise<
    NonNullable<Awaited<ReturnType<CodexAppServerClient["listMcpServerStatuses"]>>["data"]>
  >;
  resolveSessionModelState: (session: SessionRow) => Promise<{
    configuredModel: string | null;
    configuredReasoningEffort: ReasoningEffort | null;
    effectiveModel: string | null;
    effectiveReasoningEffort: ReasoningEffort | null;
  }>;
  ensureSessionThread: (session: SessionRow) => Promise<string>;
  beginActiveTurn: (
    chatId: string,
    session: SessionRow,
    threadId: string,
    turnId: string,
    turnStatus: string,
    options?: {
      mode?: "default" | "review";
    }
  ) => Promise<void>;
  submitOrQueueRichInput: (
    chatId: string,
    session: SessionRow,
    inputs: UserInput[],
    prompt: string | null,
    promptLabel: string
  ) => Promise<void>;
  getRunningTurnCapacity: (chatId: string) => {
    allowed: boolean;
    runningCount: number;
    limit: number;
  };
  resolvePendingInteractionsForSession: (
    chatId: string,
    sessionId: string,
    options: {
      state: "failed" | "expired";
      reason: string;
      resolutionSource: "server_response_success" | "server_response_error" | "app_server_exit" | "interaction_delivery_failed" | "turn_expired" | "session_clear" | "bridge_restart_recovery";
    }
  ) => Promise<void>;
  resetPendingTransientInputs: (chatId: string) => void;
  clearRecentActivity: (sessionId: string) => void;
  syncCurrentSessionCard: (chatId: string, reason: string) => Promise<void>;
  safeSendMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeSendHtmlMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeEditMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<unknown>;
  safeEditHtmlMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<unknown>;
  safeAnswerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
}

export class CodexCommandCoordinator {
  constructor(private readonly deps: CodexCommandCoordinatorDeps) {}

  async handleModel(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const requestedModel = args.trim();
    await this.deps.ensureAppServerAvailable();
    const models = await this.fetchSelectableModels();

    if (!requestedModel) {
      const modelState = await this.deps.resolveSessionModelState(activeSession);
      const picker = buildModelPickerMessage({
        session: activeSession,
        models,
        page: 0,
        modelState
      });
      await this.deps.safeSendMessage(chatId, picker.text, picker.replyMarkup);
      return;
    }

    if (requestedModel === "default" || requestedModel === "Default") {
      await this.persistSessionModelSelection(chatId, null, activeSession, null, null);
      return;
    }

    const matched = models.find((model) => model.id === requestedModel || model.model === requestedModel);
    if (!matched) {
      await this.deps.safeSendMessage(chatId, "Model not found. Send /model to select from the list.");
      return;
    }

    if (matched.supportedReasoningEfforts.length > 1) {
      const modelIndex = models.findIndex((model) => model.id === matched.id);
      const modelState = await this.deps.resolveSessionModelState(activeSession);
      const picker = buildReasoningEffortPickerMessage({
        session: activeSession,
        model: matched,
        modelIndex,
        modelState
      });
      await this.deps.safeSendMessage(chatId, picker.text, picker.replyMarkup);
      return;
    }

    await this.persistSessionModelSelection(chatId, null, activeSession, matched.id, null);
  }

  async handleModelDefaultCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This button has expired. Please try again.");
      return;
    }

    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This button has expired. Please try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    store.setSessionSelectedModel(session.sessionId, null);
    store.setSessionSelectedReasoningEffort(session.sessionId, null);
    await this.deps.safeEditMessageText(
      chatId,
      messageId,
      this.buildModelSelectionText(session.displayName, "DefaultModel + Default")
    );
  }

  async handleModelCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This button has expired. Please try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    const modelState = await this.deps.resolveSessionModelState(session);
    await this.deps.safeEditHtmlMessageText(chatId, messageId, buildModelPickerClosedText(session, modelState));
  }

  async handleModelPageCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    page: number
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This button has expired. Please try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.deps.ensureAppServerAvailable();
    const models = await this.fetchSelectableModels();
    const modelState = await this.deps.resolveSessionModelState(session);
    const picker = buildModelPickerMessage({ session, models, page, modelState });
    await this.deps.safeEditMessageText(chatId, messageId, picker.text, picker.replyMarkup);
  }

  async handleModelPickCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    modelIndex: number
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This button has expired. Please try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.deps.ensureAppServerAvailable();
    const models = await this.fetchSelectableModels();
    const model = models[modelIndex];
    if (!model) {
      await this.handleExpiredModelPicker(chatId, messageId);
      return;
    }

    if (model.supportedReasoningEfforts.length > 1) {
      const modelState = await this.deps.resolveSessionModelState(session);
      const picker = buildReasoningEffortPickerMessage({ session, model, modelIndex, modelState });
      await this.deps.safeEditMessageText(chatId, messageId, picker.text, picker.replyMarkup);
      return;
    }

    await this.persistSessionModelSelection(chatId, messageId, session, model.id, null);
  }

  async handleModelEffortCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    modelIndex: number,
    effort: ReasoningEffort | null
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This button has expired. Please try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.deps.ensureAppServerAvailable();
    const models = await this.fetchSelectableModels();
    const model = models[modelIndex];
    if (!model) {
      await this.handleExpiredModelPicker(chatId, messageId);
      return;
    }

    await this.persistSessionModelSelection(chatId, messageId, session, model.id, effort);
  }

  async handleSkills(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.listSkills({
      cwds: [activeSession.projectPath],
      forceReload: false
    });
    const entry = result.data.find((candidate) => candidate.cwd === activeSession.projectPath) ?? result.data[0];
    if (!entry) {
      await this.deps.safeSendMessage(chatId, "No skills available for the current project.");
      return;
    }

    const lines = this.buildSessionProjectContextLines(activeSession, "Available Skills");
    for (const skill of entry.skills.slice(0, 20)) {
      const description = skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description;
      const marker = skill.enabled ? "[enabled] " : "[disabled] ";
      lines.push(`${marker}${skill.name} | ${summarizeTextPreview(description, 80)}`);
    }
    if (entry.errors.length > 0) {
      lines.push(`Scan warning: ${summarizeTextPreview(String(entry.errors[0]?.message ?? entry.errors[0] ?? "unknown error"), 80)}`)
    }
    lines.push("", "Use /skill <name> :: instructions to send a skill as structured input to Codex.");
    await this.deps.safeSendMessage(chatId, lines.join("\n"));
  }

  async handleSkill(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const parsed = splitStructuredInputCommand(args);
    if (!parsed.value) {
      await this.deps.safeSendMessage(chatId, "Usage: /skill <name> :: instructions");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.listSkills({
      cwds: [activeSession.projectPath],
      forceReload: false
    });
    const entry = result.data.find((candidate) => candidate.cwd === activeSession.projectPath) ?? result.data[0];
    const skill = entry?.skills.find((candidate) => candidate.name === parsed.value);
    if (!skill) {
      await this.deps.safeSendMessage(chatId, "Skill not found. Send /skills to view available skills for the current project.");
      return;
    }

    await this.deps.submitOrQueueRichInput(chatId, activeSession, [{
      type: "skill",
      name: skill.name,
      path: skill.path
    }], parsed.prompt, `skill：${skill.name}`);
  }

  async handlePlugins(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.listPlugins({
      cwds: [activeSession.projectPath]
    });
    if (result.marketplaces.length === 0) {
      await this.deps.safeSendMessage(chatId, "No plugins available for the current project.");
      return;
    }

    const lines = this.buildSessionProjectContextLines(activeSession, "Available Plugins");
    const installExample = findFirstInstallablePlugin(result);

    for (const marketplace of result.marketplaces.slice(0, 5)) {
      lines.push(`Marketplace: ${marketplace.name}`);
      for (const plugin of marketplace.plugins.slice(0, 8)) {
        const flags = [
          plugin.installed ? "[installed]" : "[not installed]",
          plugin.enabled ? "[enabled]" : ""
        ].join("");
        const label = plugin.interface?.displayName ?? plugin.name;
        const description = plugin.interface?.shortDescription;
        lines.push(`${flags} ${plugin.id} | ${label}${description ? ` | ${summarizeTextPreview(description, 60)}` : ""}`);
      }
    }

    lines.push("", "Use /plugin install <marketplace>/<plugin> to install a plugin.");
    lines.push("Use /plugin uninstall <plugin-id> to uninstall a plugin.");
    if (installExample) {
      lines.push(`Example: /plugin install ${installExample.marketplaceName}/${installExample.pluginName}`);
    }
    await this.deps.safeSendMessage(chatId, lines.join("\n"));
  }

  async handlePlugin(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const [subcommand = "", ...rest] = args.trim().split(/\s+/u);
    const appServer = await this.deps.ensureAppServerAvailable();

    if (subcommand === "install") {
      const target = rest.join(" ").trim();
      const parsedTarget = parsePluginInstallTarget(target);
      if (!parsedTarget) {
        await this.deps.safeSendMessage(chatId, "Usage: /plugin install <marketplace>/<plugin-name>");
        return;
      }

      const result = await appServer.listPlugins({
        cwds: [activeSession.projectPath]
      });
      const marketplace = result.marketplaces.find((entry) => entry.name === parsedTarget.marketplaceName);
      const plugin = marketplace?.plugins.find((entry) => entry.name === parsedTarget.pluginName);
      if (!marketplace || !plugin) {
        await this.deps.safeSendMessage(chatId, "Plugin not found. Send /plugins to view available plugins.");
        return;
      }

      const installResult = await appServer.installPlugin({
        marketplacePath: marketplace.path,
        pluginName: plugin.name
      });
      const lines = [`Installed plugin "${plugin.name}" for project "${this.projectDisplayName(activeSession)}"`];
      if (installResult.appsNeedingAuth.length > 0) {
        lines.push("", "These apps may require additional authorization：");
        for (const app of installResult.appsNeedingAuth.slice(0, 5)) {
          lines.push(`- ${app.name}${app.installUrl ? ` | ${app.installUrl}` : ""}`);
        }
      }
      await this.deps.safeSendMessage(chatId, lines.join("\n"));
      return;
    }

    if (subcommand === "uninstall") {
      const pluginId = rest.join(" ").trim();
      if (!pluginId) {
        await this.deps.safeSendMessage(chatId, "Usage: /plugin uninstall <plugin-id>");
        return;
      }

      await appServer.uninstallPlugin(pluginId);
      await this.deps.safeSendMessage(chatId, `Uninstalled plugin "${pluginId}" from project "${this.projectDisplayName(activeSession)}"`);
      return;
    }

    await this.deps.safeSendMessage(chatId, "Usage: /plugin install <marketplace>/<plugin-name> or /plugin uninstall <plugin-id>");
  }

  async handleApps(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    await this.deps.ensureAppServerAvailable();
    const apps = await this.deps.fetchAllApps(activeSession.threadId ?? undefined);
    if (apps.length === 0) {
      await this.deps.safeSendMessage(chatId, "No apps available to list.");
      return;
    }

    const lines = this.buildSessionProjectContextLines(activeSession, "Available Apps");
    for (const app of apps.slice(0, 12)) {
      const flags = [
        app.isAccessible ? "[accessible]" : "[not accessible]",
        app.isEnabled ? "[enabled]" : "[disabled]"
      ].join("");
      lines.push(`${flags} ${app.name}${app.description ? ` | ${summarizeTextPreview(app.description, 70)}` : ""}`);
      if (app.pluginDisplayNames.length > 0) {
        lines.push(`Source plugin: ${app.pluginDisplayNames.join(", ")}`);
      }
      if (app.installUrl) {
        lines.push(`Install URL: ${app.installUrl}`);
      }
    }

    await this.deps.safeSendMessage(chatId, lines.join("\n"));
  }

  async handleMcp(chatId: string, args: string): Promise<void> {
    const trimmed = args.trim();
    const [subcommand = "", ...rest] = trimmed.split(/\s+/u);
    const appServer = await this.deps.ensureAppServerAvailable();

    if (!trimmed) {
      const statuses = await this.deps.fetchAllMcpServerStatuses();
      if (statuses.length === 0) {
        await this.deps.safeSendMessage(chatId, "No MCP servers available to list.");
        return;
      }

      const lines = ["MCP Server Status"];
      for (const status of statuses.slice(0, 12)) {
        lines.push(
          `${status.name} | ${formatMcpAuthStatus(status.authStatus)} | Tools ${Object.keys(status.tools).length} | Resource ${status.resources.length} | Templates ${status.resourceTemplates.length}`
        );
      }
      lines.push("", "Use /mcp reload to reload config, or /mcp login <name> to start OAuth login.");
      await this.deps.safeSendMessage(chatId, lines.join("\n"));
      return;
    }

    if (subcommand === "reload") {
      await appServer.reloadMcpServers();
      await this.deps.safeSendMessage(chatId, "MCP server config reloaded.");
      return;
    }

    if (subcommand === "login") {
      const serverName = rest.join(" ").trim();
      if (!serverName) {
        await this.deps.safeSendMessage(chatId, "Usage: /mcp login <name>");
        return;
      }

      const result = await appServer.loginToMcpServer({ name: serverName });
      if (!result.authorizationUrl) {
        await this.deps.safeSendMessage(chatId, "Unable to generate the login link for this MCP server.");
        return;
      }

      await this.deps.safeSendMessage(
        chatId,
        `Generated MCP login link: ${serverName}\n${result.authorizationUrl}\nSend /mcp again after completion to check the latest status.`
      );
      return;
    }

    await this.deps.safeSendMessage(chatId, "Usage: /mcp, /mcp reload, or /mcp login <name>");
  }

  async handleAccount(chatId: string): Promise<void> {
    const appServer = await this.deps.ensureAppServerAvailable();
    const accountResult = await appServer.readAccount(false);
    let rateLimitsResult: Awaited<ReturnType<CodexAppServerClient["readAccountRateLimits"]>> | null = null;

    try {
      rateLimitsResult = await appServer.readAccountRateLimits();
    } catch {
      rateLimitsResult = null;
    }

    const lines = ["Current Codex Account"];
    if (!accountResult.account) {
      lines.push("Account: Not logged in");
    } else if (accountResult.account.type === "apiKey") {
      lines.push("Type: API Key");
    } else {
      lines.push("Type: ChatGPT");
      lines.push(`Email：${accountResult.account.email}`);
      lines.push(`Plan：${accountResult.account.planType}`);
    }
    lines.push(`Need  OpenAI Auth：${accountResult.requiresOpenaiAuth ? "Yes" : "No"}`);

    const rateSummary = formatRateLimitSummary(rateLimitsResult?.rateLimits ?? null);
    if (rateSummary) {
      lines.push(rateSummary);
    }

    await this.deps.safeSendMessage(chatId, lines.join("\n"));
  }

  async handleReview(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Current project is still running. Please wait for completion or stop the current operation.");
      return;
    }

    const capacity = this.deps.getRunningTurnCapacity(chatId);
    if (!capacity.allowed) {
      await this.deps.safeSendMessage(
        chatId,
        `Maximum concurrent sessions is ${capacity.limit}. Please wait or stop a running session.`
      );
      return;
    }

    const parsed = parseReviewCommandArgs(args);
    if (!parsed) {
      await this.deps.safeSendMessage(
        chatId,
        "Usage: /review [detached] [branch <branch>|commit <SHA>|custom <instructions>]"
      );
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const threadId = await this.deps.ensureSessionThread(activeSession);
    const result = await appServer.reviewStart({
      threadId,
      target: parsed.target,
      ...(parsed.delivery ? { delivery: parsed.delivery } : {})
    });

    let reviewSession = store.getSessionById(activeSession.sessionId) ?? activeSession;
    if (result.reviewThreadId !== threadId) {
      reviewSession = store.createSession({
        chatId,
        projectName: activeSession.projectName,
        projectPath: activeSession.projectPath,
        displayName: `Review: ${activeSession.displayName}`,
        displayNameSource: "manual",
        selectedModel: activeSession.selectedModel,
        selectedReasoningEffort: activeSession.selectedReasoningEffort,
        planMode: activeSession.planMode,
        needsDefaultCollaborationModeReset: activeSession.needsDefaultCollaborationModeReset
      });
      store.updateSessionThreadId(reviewSession.sessionId, result.reviewThreadId);
      reviewSession = store.getSessionById(reviewSession.sessionId) ?? reviewSession;
      await this.deps.safeSendMessage(chatId, `Created review session: ${reviewSession.displayName}`);
    }

    await this.deps.beginActiveTurn(chatId, reviewSession, result.reviewThreadId, result.turn.id, result.turn.status, {
      mode: "review"
    });
  }

  async handleFork(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.deps.safeSendMessage(chatId, "Current session has no Codex thread to fork. Please complete a task first.");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Current project is still running. Please wait for completion or stop the current operation.");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const forked = await appServer.forkThread({
      threadId: activeSession.threadId,
      ...(activeSession.selectedModel ? { model: activeSession.selectedModel } : {})
    });
    const lastForkTurn = forked.thread.turns.at(-1) ?? null;
    const requestedForkName = args.trim();
    const created = store.createSession({
      chatId,
      projectName: activeSession.projectName,
      projectPath: activeSession.projectPath,
      displayName: requestedForkName || `Fork: ${activeSession.displayName}`,
      displayNameSource: requestedForkName ? "manual" : "auto",
      selectedModel: activeSession.selectedModel ?? forked.model,
      selectedReasoningEffort: activeSession.selectedReasoningEffort ?? forked.reasoningEffort ?? null,
      planMode: activeSession.planMode,
      needsDefaultCollaborationModeReset: activeSession.needsDefaultCollaborationModeReset,
      threadId: forked.thread.id,
      lastTurnId: lastForkTurn?.id ?? activeSession.lastTurnId,
      lastTurnStatus: lastForkTurn?.status ?? activeSession.lastTurnStatus
    });
    await this.deps.safeSendMessage(chatId, `Created forked session: ${created.displayName}`);
  }

  async handleRollback(chatId: string, args: string): Promise<void> {
    const session = this.getIdleRollbackSession(chatId);
    if (!session) {
      return;
    }

    const trimmed = args.trim();
    if (!trimmed) {
      const targets = await this.buildRollbackTargets(session);
      if (targets.length === 0) {
        await this.deps.safeSendMessage(chatId, "No rollback targets available.");
        return;
      }

      const rendered = buildRollbackPickerMessage(createRollbackPickerView({
        sessionId: session.sessionId,
        page: 0,
        targets
      }));
      await this.deps.safeSendHtmlMessage(chatId, rendered.text, rendered.replyMarkup);
      return;
    }

    const numTurns = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(numTurns) || numTurns < 1) {
      await this.deps.safeSendMessage(chatId, "Usage: /rollback or /rollback <number-of-turns>");
      return;
    }

    await this.executeRollback(session, numTurns);
    await this.deps.safeSendMessage(chatId, buildRollbackSuccessText(numTurns, session.displayName));
  }

  async handleRollbackPickerCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    options:
      | {
          mode: "list";
          page: number;
        }
      | {
          mode: "confirm";
          page: number;
          targetIndex: number;
        }
  ): Promise<void> {
    const session = this.getRollbackSessionForCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This button has expired. Please resend /rollback.");
      return;
    }

    const targets = await this.buildRollbackTargets(session);
    if (targets.length === 0) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "No rollback targets available.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);

    if (options.mode === "confirm") {
      const target = targets.find((candidate) => candidate.index === options.targetIndex);
      if (!target) {
        await this.deps.safeEditMessageText(chatId, messageId, "This rollback target is no longer valid. Please resend /rollback.");
        return;
      }

      const rendered = buildRollbackConfirmMessage(createRollbackConfirmView({
        sessionId,
        page: options.page,
        target
      }));
      await this.deps.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
      return;
    }

    const rendered = buildRollbackPickerMessage(createRollbackPickerView({
      sessionId,
      page: options.page,
      targets
    }));
    await this.deps.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
  }

  async handleRollbackConfirmCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    targetIndex: number
  ): Promise<void> {
    const session = this.getRollbackSessionForCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This button has expired. Please resend /rollback.");
      return;
    }

    const targets = await this.buildRollbackTargets(session);
    const target = targets.find((candidate) => candidate.index === targetIndex);
    if (!target || target.rollbackCount < 1) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This rollback target is no longer valid. Please resend /rollback.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.executeRollback(session, target.rollbackCount);
    await this.deps.safeEditMessageText(
      chatId,
      messageId,
      `Rolled back to: ${target.sequenceNumber}. ${target.label}\n${buildRollbackSuccessText(target.rollbackCount, session.displayName)}`
    );
  }

  async handleRollbackCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const session = this.getRollbackSessionForCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This button has expired. Please resend /rollback.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.deps.safeEditHtmlMessageText(chatId, messageId, buildRollbackClosedMessage());
  }

  async handleCompact(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.deps.safeSendMessage(chatId, "Current session has no Codex thread to compact.");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Current project is still running. Please wait for completion or stop the current operation.");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    await appServer.compactThread(activeSession.threadId);
    await this.deps.safeSendMessage(chatId, `For session "${activeSession.displayName}" requested to compact the current thread.`);
  }

  async handleClear(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Current project is still running. Please wait for completion or stop the current operation.");
      return;
    }

    const previousThreadId = activeSession.threadId;
    if (previousThreadId) {
      const archivedSnapshot = store.createSession({
        chatId,
        projectName: activeSession.projectName,
        projectPath: activeSession.projectPath,
        displayName: this.buildClearedSnapshotName(activeSession.displayName),
        displayNameSource: "manual",
        selectedModel: activeSession.selectedModel,
        selectedReasoningEffort: activeSession.selectedReasoningEffort,
        planMode: activeSession.planMode,
        needsDefaultCollaborationModeReset: activeSession.needsDefaultCollaborationModeReset,
        threadId: previousThreadId,
        lastTurnId: activeSession.lastTurnId,
        lastTurnStatus: activeSession.lastTurnStatus
      });
      store.archiveSession(archivedSnapshot.sessionId);
      store.setActiveSession(chatId, activeSession.sessionId);
    }

    await this.deps.resolvePendingInteractionsForSession(chatId, activeSession.sessionId, {
      state: "expired",
      reason: "session_cleared",
      resolutionSource: "session_clear"
    });
    this.deps.resetPendingTransientInputs(chatId);
    store.updateSessionStatus(activeSession.sessionId, "idle", {
      lastTurnId: null,
      lastTurnStatus: null
    });
    const started = await this.deps.startFreshThreadForClear(activeSession);
    store.updateSessionThreadId(activeSession.sessionId, started.thread.id);
    this.deps.clearRecentActivity(activeSession.sessionId);
    await this.deps.syncCurrentSessionCard(chatId, "session_cleared");
    await this.deps.safeSendMessage(
      chatId,
      previousThreadId
        ? `Cleared context for session "${activeSession.displayName}" context and switched to a new Codex thread. The previous thread has been preserved in archived sessions, viewable with /sessions archived.`
        : `Reset session "${activeSession.displayName}" and started a new Codex thread.`
    );
  }

  async handleThreadCommand(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.deps.safeSendMessage(chatId, "Current session has no Codex thread yet. Please complete a task first.");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Current project is still running. Please wait for completion or stop the current operation.");
      return;
    }

    const trimmed = args.trim();
    const [subcommand, ...rest] = trimmed.split(/\s+/u);
    if (!subcommand) {
      await this.deps.safeSendMessage(
        chatId,
        "Usage: /thread name <name> or /thread meta branch=<branch> sha=<commit> origin=<URL> or /thread clean-terminals"
      );
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();

    if (subcommand === "name") {
      const nextName = rest.join(" ").trim();
      if (!nextName) {
        await this.deps.safeSendMessage(chatId, "Usage: /thread name <name>");
        return;
      }

      await appServer.setThreadName(activeSession.threadId, nextName);
      store.renameSession(activeSession.sessionId, nextName);
      await this.deps.safeSendMessage(chatId, `Session title updated to: ${nextName}`);
      return;
    }

    if (subcommand === "meta") {
      const gitInfo = parseThreadMetadataTokens(rest);
      if (!gitInfo) {
        await this.deps.safeSendMessage(chatId, "Usage: /thread meta branch=<branch> sha=<commit> origin=<URL>");
        return;
      }

      await appServer.updateThreadMetadata({
        threadId: activeSession.threadId,
        gitInfo
      });
      const fragments = [
        gitInfo.branch !== undefined ? `branch=${gitInfo.branch ?? "clear"}` : null,
        gitInfo.sha !== undefined ? `sha=${gitInfo.sha ?? "clear"}` : null,
        gitInfo.originUrl !== undefined ? `origin=${gitInfo.originUrl ?? "clear"}` : null
      ].filter((value): value is string => Boolean(value));
      await this.deps.safeSendMessage(
        chatId,
        `For session "${activeSession.displayName}": ${fragments.join(", ")}`
      );
      return;
    }

    if (subcommand === "clean-terminals") {
      await appServer.cleanBackgroundTerminals(activeSession.threadId);
      await this.deps.safeSendMessage(chatId, `For session "${activeSession.displayName}".`);
      return;
    }

    await this.deps.safeSendMessage(
      chatId,
      "Usage: /thread name <name> or /thread meta branch=<branch> sha=<commit> origin=<URL> or /thread clean-terminals"
    );
  }

  private getActiveSessionForModelCallback(chatId: string, sessionId: string): SessionRow | null {
    const store = this.deps.getStore();
    if (!store) {
      return null;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId) {
      return null;
    }

    return activeSession;
  }

  private projectDisplayName(session: Pick<SessionRow, "projectName" | "projectAlias">): string {
    return session.projectAlias?.trim() || session.projectName;
  }

  private buildSessionProjectContextLines(
    session: Pick<SessionRow, "displayName" | "projectName" | "projectAlias">,
    title: string
  ): string[] {
    return [
      `Session: ${session.displayName}`,
      `Current project：${this.projectDisplayName(session)}`,
      title
    ];
  }

  private buildModelSelectionText(sessionName: string, nextConfig: string): string {
    return `Model for session "${sessionName}" set to: ${nextConfig}\nTakes effect on next task.`;
  }

  private async handleExpiredModelPicker(chatId: string, messageId: number): Promise<void> {
    await this.deps.safeEditMessageText(chatId, messageId, "This model list has expired. Please resend /model.");
  }

  private async fetchSelectableModels(): ReturnType<CodexCommandCoordinatorDeps["fetchAllModels"]> {
    const models = await this.deps.fetchAllModels();
    return models.filter((model) => !/^gpt-5\.6(?:-|$)/.test(model.id) && !/^gpt-5\.6(?:-|$)/.test(model.model));
  }

  private async persistSessionModelSelection(
    chatId: string,
    messageId: number | null,
    session: SessionRow,
    modelId: string | null,
    effort: ReasoningEffort | null
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    store.setSessionSelectedModel(session.sessionId, modelId);
    store.setSessionSelectedReasoningEffort(session.sessionId, effort);

    const nextConfig = formatSessionModelReasoningConfig({
      selectedModel: modelId,
      selectedReasoningEffort: effort
    });
    const text = this.buildModelSelectionText(session.displayName, nextConfig);

    if (messageId === null) {
      await this.deps.safeSendMessage(chatId, text);
      return;
    }

    await this.deps.safeEditMessageText(chatId, messageId, text);
  }

  private getIdleRollbackSession(chatId: string): SessionRow | null {
    const store = this.deps.getStore();
    if (!store) {
      return null;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      void this.deps.safeSendMessage(chatId, "Current session has no Codex thread to rollback.");
      return null;
    }

    if (activeSession.status === "running") {
      void this.deps.safeSendMessage(chatId, "Current project is still running. Please wait for completion or stop the current operation.");
      return null;
    }

    return activeSession;
  }

  private getRollbackSessionForCallback(chatId: string, sessionId: string): SessionRow | null {
    const store = this.deps.getStore();
    if (!store) {
      return null;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId || !activeSession.threadId) {
      return null;
    }

    if (activeSession.status === "running") {
      return null;
    }

    return activeSession;
  }

  private async executeRollback(session: SessionRow, numTurns: number): Promise<void> {
    const store = this.deps.getStore();
    if (!store || !session.threadId) {
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.rollbackThread(session.threadId, numTurns);
    const lastTurn = result.thread.turns.at(-1) ?? null;
    store.updateSessionStatus(session.sessionId, "idle", {
      lastTurnId: lastTurn?.id ?? null,
      lastTurnStatus: lastTurn?.status ?? null
    });
    this.deps.clearRecentActivity(session.sessionId);
  }

  private async buildRollbackTargets(session: SessionRow): Promise<RollbackTargetView[]> {
    if (!session.threadId) {
      return [];
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.readThread(session.threadId, true);
    const threadRecord = asRecord(result.thread);
    const turns = getArray(threadRecord, "turns");
    const targets: RollbackTargetView[] = [];
    let sequenceNumber = 1;

    for (let turnIndex = turns.length - 2; turnIndex >= 0; turnIndex -= 1) {
      const turn = asRecord(turns[turnIndex]);
      const label = this.summarizeRollbackTargetInput(session.threadId, turn);
      if (!label) {
        continue;
      }

      targets.push({
        index: turnIndex,
        sequenceNumber,
        label,
        rollbackCount: turns.length - turnIndex - 1
      });
      sequenceNumber += 1;
    }

    return targets;
  }

  private summarizeRollbackTargetInput(threadId: string, turn: Record<string, unknown> | null): string | null {
    const turnId = getString(turn, "id");
    if (turnId) {
      const source = this.deps.getStore()?.getTurnInputSource(threadId, turnId);
      if (source?.sourceKind === "voice") {
        return truncateText(`Voice: ${normalizeWhitespace(source.transcript)}`, HISTORY_TEXT_LIMIT);
      }
    }

    const userMessage = asRecord(turn?.userMessage);
    const content = getArray(userMessage, "content");
    if (content.length === 0) {
      return null;
    }

    const textParts: string[] = [];
    const labels: string[] = [];

    for (const item of content) {
      const record = asRecord(item);
      const type = getString(record, "type");
      switch (type) {
        case "text": {
          const text = normalizeWhitespace(getString(record, "text") ?? "");
          if (text) {
            textParts.push(text);
          }
          break;
        }
        case "image":
        case "localImage":
          labels.push("image input");
          break;
        case "skill":
          labels.push(`skill: ${getString(record, "name") ?? "unknown"}`);
          break;
        case "mention":
          labels.push(`Mention: ${getString(record, "name") ?? getString(record, "path") ?? "unknown"}`);
          break;
        default:
          labels.push("structured input");
          break;
      }
    }

    const summary = textParts.length > 0
      ? textParts.join(" ")
      : labels.length > 0
        ? labels.join(" + ")
        : null;
    return summary ? truncateText(summary, HISTORY_TEXT_LIMIT) : null;
  }

  private buildClearedSnapshotName(displayName: string): string {
    return displayName.startsWith("Before clear: ") ? displayName : `Before clear: ${displayName}`;
  }
}

function parseReviewCommandArgs(args: string): ReviewCommandArgs | null {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let delivery: "inline" | "detached" | undefined;
  let index = 0;

  if (tokens[0] === "detached") {
    delivery = "detached";
    index += 1;
  }

  const kind = tokens[index];
  if (!kind) {
    return {
      ...(delivery ? { delivery } : {}),
      target: { type: "uncommittedChanges" }
    };
  }

  if (kind === "branch" && tokens[index + 1]) {
    return {
      ...(delivery ? { delivery } : {}),
      target: {
        type: "baseBranch",
        branch: tokens.slice(index + 1).join(" ")
      }
    };
  }

  if (kind === "commit" && tokens[index + 1]) {
    return {
      ...(delivery ? { delivery } : {}),
      target: {
        type: "commit",
        sha: tokens[index + 1] ?? ""
      }
    };
  }

  if (kind === "custom" && tokens[index + 1]) {
    return {
      ...(delivery ? { delivery } : {}),
      target: {
        type: "custom",
        instructions: tokens.slice(index + 1).join(" ")
      }
    };
  }

  return null;
}

function parseThreadMetadataTokens(tokens: string[]): ThreadMetadataUpdate | null {
  const gitInfo: ThreadMetadataUpdate = {};

  for (const token of tokens) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex === -1) {
      return null;
    }

    const key = token.slice(0, separatorIndex).trim();
    const rawValue = token.slice(separatorIndex + 1).trim();
    const value = rawValue === "-" ? null : rawValue;
    switch (key) {
      case "branch":
        gitInfo.branch = value;
        break;
      case "sha":
        gitInfo.sha = value;
        break;
      case "origin":
      case "originUrl":
        gitInfo.originUrl = value;
        break;
      default:
        return null;
    }
  }

  return Object.keys(gitInfo).length > 0 ? gitInfo : null;
}

function parsePluginInstallTarget(value: string): { marketplaceName: string; pluginName: string } | null {
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  return {
    marketplaceName: trimmed.slice(0, slashIndex),
    pluginName: trimmed.slice(slashIndex + 1)
  };
}

function findFirstInstallablePlugin(
  result: Awaited<ReturnType<CodexAppServerClient["listPlugins"]>>
): { marketplaceName: string; pluginName: string } | null {
  for (const marketplace of result.marketplaces) {
    const plugin = marketplace.plugins.find((entry) => !entry.installed);
    if (plugin) {
      return {
        marketplaceName: marketplace.name,
        pluginName: plugin.name
      };
    }
  }

  return null;
}

function formatMcpAuthStatus(status: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth"): string {
  switch (status) {
    case "unsupported":
      return "Auth not supported";
    case "notLoggedIn":
      return "Not logged in";
    case "bearerToken":
      return "Bearer Token";
    case "oAuth":
      return "OAuth";
    default:
      return status;
  }
}

function formatRateLimitSummary(rateLimits: {
  limitName: string | null;
  primary: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  planType: string | null;
} | null): string | null {
  if (!rateLimits) {
    return null;
  }

  const parts: string[] = [];
  if (rateLimits.limitName) {
    parts.push(`Quota：${rateLimits.limitName}`);
  }
  if (rateLimits.planType) {
    parts.push(`LimitPlan：${rateLimits.planType}`);
  }
  if (rateLimits.primary) {
    const window = rateLimits.primary.windowDurationMins ? `${rateLimits.primary.windowDurationMins} min` : "current window";
    parts.push(`Primary quota usage: ${rateLimits.primary.usedPercent}%（${window}）`);
  }
  if (rateLimits.credits) {
    parts.push(
      rateLimits.credits.unlimited
        ? "Credits: Unlimited"
        : `Credits: ${rateLimits.credits.balance ?? (rateLimits.credits.hasCredits ? "available" : "unavailable")}`
    );
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function buildRollbackSuccessText(numTurns: number, sessionName?: string): string {
  const summary = sessionName
    ? `For session "${sessionName}" rolled back the last ${numTurns} turn(s).`
    : `Rolled back the last ${numTurns} turn(s).`;
  return `${summary}\nNote: This will not undo changes already written to local files by the agent。`;
}
