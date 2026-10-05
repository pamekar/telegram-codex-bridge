import type {
  PendingInteractionState,
  RuntimeStatusField,
  UiLanguage
} from "../types.js";
import { BRIDGE_EXTENSION_RUNTIME_STATUS_FIELDS, CODEX_CLI_RUNTIME_STATUS_FIELDS } from "../types.js";
import type { ActivityStatus, CollabAgentStateSnapshot, InspectSnapshot } from "../activity/types.js";
import type {
  InteractionApprovalCardView,
  InteractionExpiredCardView,
  InteractionQuestionCardView,
  InteractionResolvedCardView
} from "../core/interaction-model/interaction.js";
import type {
  RuntimeCommandEntryView,
  RuntimeInspectControlsView,
  RuntimeInspectView,
  RuntimeHubSessionView,
  RuntimeHubTerminalSummaryView,
  RuntimeHubView,
  RollbackConfirmView,
  RollbackPickerView,
  RollbackTargetView,
  RuntimePreferencesView,
  RuntimeStatusCardView,
  RuntimeStatusControlsView
} from "../core/interaction-model/runtime.js";
import { truncateText } from "../util/text.js";
import { BLOCKED_PROGRESS_APPROVAL, BLOCKED_PROGRESS_USER_INPUT } from "../util/blocked-progress.js";
import type { TelegramInlineKeyboardButton, TelegramInlineKeyboardMarkup } from "./api.js";
import {
  encodeAgentCollapseCallback,
  encodeAgentExpandCallback,
  encodeCommandPanelOpenCallback,
  encodeHubSelectCallback,
  encodeInspectCollapseCallback,
  encodeInspectCloseCallback,
  encodeInspectExpandCallback,
  encodeInspectPageCallback,
  encodeInteractionAnswerCollapseCallback,
  encodeInteractionAnswerExpandCallback,
  encodeInteractionCancelCallback,
  encodeInteractionDecisionCallback,
  encodeInteractionQuestionCallback,
  encodeInteractionTextCallback,
  encodePlanCollapseCallback,
  encodePlanExpandCallback,
  encodeRollbackBackCallback,
  encodeRollbackCloseCallback,
  encodeRollbackConfirmCallback,
  encodeRollbackPageCallback,
  encodeRollbackPickCallback,
  encodeRuntimeCloseCallback,
  encodeRuntimePageCallback,
  encodeRuntimeResetCallback,
  encodeRuntimeSaveCallback,
  encodeRuntimeToggleCallback,
  encodeStatusInspectCallback,
  encodeStatusInterruptCallback
} from "./ui-callbacks.js";
import { renderInlineMarkdown } from "./ui-final-answer.js";
import {
  chunkButtons,
  escapeHtml,
  formatHtmlField,
  formatHtmlHeading,
  formatRelativeTime
} from "./ui-shared.js";
import { buildBridgeCommandActionRows } from "./ui-bridge-actions.js";

export type {
  InteractionApprovalCardView,
  InteractionExpiredCardView,
  InteractionQuestionCardView,
  InteractionResolvedCardView
} from "../core/interaction-model/interaction.js";
export type {
  RuntimeCommandEntryView,
  RuntimeInspectControlsView,
  RuntimeInspectView,
  RuntimeHubSessionView,
  RuntimeHubTerminalSummaryView,
  RuntimeHubView,
  RollbackConfirmView,
  RollbackPickerView,
  RollbackTargetView,
  RuntimePreferencesView,
  RuntimeStatusCardView,
  RuntimeStatusControlsView
} from "../core/interaction-model/runtime.js";

type InteractionApprovalCardRenderView = Omit<InteractionApprovalCardView, "kind">;
type InteractionQuestionCardRenderView = Omit<InteractionQuestionCardView, "kind">;
type InteractionResolvedCardRenderView = Omit<InteractionResolvedCardView, "kind">;
type InteractionExpiredCardRenderView = Omit<InteractionExpiredCardView, "kind">;

interface RuntimeCardContext {
  sessionName?: string | null;
  projectName?: string | null;
}

export interface RuntimeStatusFieldOptionView {
  field: RuntimeStatusField;
  label: string;
  selected: boolean;
}

const RUNTIME_FIELD_PAGE_SIZE = 4;
const ROLLBACK_TARGET_PAGE_SIZE = 6;
const HUB_COMMAND_REMINDER_TEXT = "💡 Tip: Send /hub to view or refresh the Hub.";
const HUB_SECTION_DIVIDER = "━━━━━━━━━━━━━━━━━━";
const INSPECT_PAGE_CHAR_LIMIT = 3200;

export function buildRuntimeStatusCard(options: RuntimeStatusCardView): string {
  const language = options.language ?? "zh";
  const progressTextLimit = options.progressTextLimit ?? 240;
  const expandedPlanEntryLimit = options.expandedPlanEntryLimit ?? 10;
  const expandedPlanEntryTextLimit = options.expandedPlanEntryTextLimit ?? 200;
  const expandedAgentLimit = options.expandedAgentLimit ?? 10;
  const expandedAgentProgressTextLimit = options.expandedAgentProgressTextLimit ?? 160;
  const lines: string[] = [formatHtmlHeading(language === "en" ? "Runtime Status" : "Runtime")];
  pushHtmlRuntimeCardContext(lines, options, language);

  lines.push(formatRuntimeCardRow(language === "en" ? "State" : "Status", options.state));

  for (const line of options.optionalFieldLines ?? []) {
    lines.push(formatRuntimeStatusOptionalField(line, language));
  }

  if (options.progressText) {
    const progressText = renderInlineMarkdown(truncateText(options.progressText, progressTextLimit));
    if (stripHtml(progressText).length > 72) {
      lines.push(formatHtmlHeading(language === "en" ? "Progress" : "Progress"));
      lines.push(progressText);
    } else {
      lines.push(formatRuntimeCardRow(language === "en" ? "Progress" : "Progress", progressText, { valueIsHtml: true }));
    }
  }

  appendExpandedPlanSection(lines, {
    language,
    entries: options.planEntries,
    expanded: options.planExpanded,
    entryLimit: expandedPlanEntryLimit,
    entryTextLimit: expandedPlanEntryTextLimit
  });

  appendExpandedAgentSection(lines, {
    language,
    entries: options.agentEntries,
    expanded: options.agentsExpanded,
    entryLimit: expandedAgentLimit,
    entryProgressTextLimit: expandedAgentProgressTextLimit
  });

  if (options.includeFooter ?? true) {
    lines.push(buildRuntimeSurfaceFooter(language));
  }
  return lines.join("\n");
}

export function buildRuntimeStatusReplyMarkup(options: RuntimeStatusControlsView): TelegramInlineKeyboardMarkup | undefined {
  const language = options.language ?? "zh";
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];

  if (options.planEntries.length > 0) {
    rows.push([{
      text: options.planExpanded
        ? (language === "en" ? "Hide Plan" : "Collapse Plan")
        : buildCollapsedPlanButtonLabel(options.planEntries, language),
      callback_data: options.planExpanded
        ? encodePlanCollapseCallback(options.sessionId)
        : encodePlanExpandCallback(options.sessionId)
    }]);
  }

  if (options.agentEntries.length > 0) {
    rows.push([{
      text: options.agentsExpanded
        ? (language === "en" ? "Hide Agents" : "Hide Agents")
        : buildCollapsedAgentButtonLabel(options.agentEntries, language),
      callback_data: options.agentsExpanded
        ? encodeAgentCollapseCallback(options.sessionId)
        : encodeAgentExpandCallback(options.sessionId)
    }]);
  }

  rows.push([
    {
      text: language === "en" ? "Inspect" : "Inspect",
      callback_data: encodeStatusInspectCallback(options.sessionId)
    },
    {
      text: language === "en" ? "Commands" : "Command",
      callback_data: encodeCommandPanelOpenCallback()
    },
    {
      text: language === "en" ? "Interrupt" : "Stopoperation",
      callback_data: encodeStatusInterruptCallback(options.sessionId)
    }
  ]);

  return {
    inline_keyboard: rows
  };
}

export function buildRuntimeHubMessage(options: RuntimeHubView): string {
  const language = options.language ?? "zh";
  const sessionProgressTextLimit = options.sessionProgressTextLimit ?? 120;
  const currentViewedSessionProgressTextLimit = options.currentViewedSessionProgressTextLimit ?? sessionProgressTextLimit;
  const otherSessionProgressTextLimit = options.otherSessionProgressTextLimit ?? sessionProgressTextLimit;
  const recentEndedSessionProgressTextLimit = options.recentEndedSessionProgressTextLimit ?? 0;
  const hubPlanEntryLimit = options.hubPlanEntryLimit ?? 6;
  const hubPlanEntryTextLimit = options.hubPlanEntryTextLimit ?? 120;
  const hubAgentEntryLimit = options.hubAgentEntryLimit ?? 4;
  const hubAgentProgressTextLimit = options.hubAgentProgressTextLimit ?? 100;
  const usesSlotSections = options.completed !== undefined
    || options.currentViewedSession !== undefined
    || options.otherSessions !== undefined
    || options.recentEndedSessions !== undefined;
  const lines: string[] = [buildRuntimeHubHeading(
    language === "en"
      ? `Hub: ${options.windowIndex + 1}/${Math.max(1, options.totalWindows)}${options.completed ? " · Completed" : ""}`
      : `Slot ${options.windowIndex + 1}/${Math.max(1, options.totalWindows)}${options.completed ? " · Done" : ""}`
  )];

  if (usesSlotSections) {
    if (options.currentViewedSession) {
      pushRuntimeHubSectionHeading(lines, language === "en" ? "Current viewed session" : "Viewed Session");
      pushRuntimeHubSession(lines, options.currentViewedSession, null, {
        language,
        progressTextLimit: currentViewedSessionProgressTextLimit,
        emphasizeMarkers: false,
        showMarkers: false
      });

      appendExpandedHubPlanSection(lines, {
        language,
        entries: options.planEntries,
        expanded: options.planExpanded,
        entryLimit: hubPlanEntryLimit,
        entryTextLimit: hubPlanEntryTextLimit
      });

      appendExpandedHubAgentSection(lines, {
        language,
        entries: options.agentEntries,
        expanded: options.agentsExpanded,
        entryLimit: hubAgentEntryLimit,
        entryProgressTextLimit: hubAgentProgressTextLimit
      });
    }

    if ((options.otherSessions?.length ?? 0) > 0) {
      pushRuntimeHubSectionHeading(lines, language === "en" ? "Other running sessions" : "Other Running Sessions");
      for (const session of options.otherSessions ?? []) {
        pushRuntimeHubSession(lines, session, null, {
          language,
          progressTextLimit: otherSessionProgressTextLimit,
          emphasizeMarkers: false,
          showMarkers: false
        });
      }
    }

    if ((options.recentEndedSessions?.length ?? 0) > 0) {
      pushRuntimeHubSectionHeading(lines, language === "en" ? "Recent ended sessions" : "Recently Completed");
      for (const session of options.recentEndedSessions ?? []) {
        pushRuntimeHubSession(lines, session, null, {
          language,
          progressTextLimit: recentEndedSessionProgressTextLimit,
          emphasizeMarkers: false,
          showMarkers: false
        });
      }
    }

    if (options.reminderText) {
      lines.push("", escapeHtml(options.reminderText));
    }
    lines.push("", buildRuntimeHubFooter(language));
    return lines.join("\n");
  }

  const sessionCollectionKind = options.sessionCollectionKind ?? "running";
  const genericSessionLayout = options.genericSessionLayout ?? "detailed";
  const sessions = options.sessions ?? [];
  const focusedSession = sessions.find((session) => session.isFocused) ?? sessions[0] ?? null;
  const allOtherSessions = sessions.filter((session) => session.sessionId !== focusedSession?.sessionId);
  const genericVisibleSessionLimit = options.genericVisibleSessionLimit && options.genericVisibleSessionLimit > 0
    ? options.genericVisibleSessionLimit
    : null;
  const visibleOtherSessionLimit = genericVisibleSessionLimit === null
    ? allOtherSessions.length
    : Math.max(0, genericVisibleSessionLimit - (focusedSession ? 1 : 0));
  const otherSessions = allOtherSessions.slice(0, visibleOtherSessionLimit);
  const hiddenOtherSessionCount = allOtherSessions.length - otherSessions.length;
  const activeInputSession = options.activeInputSession
    && !sessions.some((session) => session.sessionId === options.activeInputSession?.sessionId)
    ? options.activeInputSession
    : null;

  lines[0] = buildRuntimeHubHeading(
    language === "en"
      ? `Hub: ${options.windowIndex + 1}/${Math.max(1, options.totalWindows)} · ${(options.totalSessions ?? sessions.length)} session${(options.totalSessions ?? sessions.length) === 1 ? "" : "s"}`
      : `Slot ${options.windowIndex + 1}/${Math.max(1, options.totalWindows)} · ${options.totalSessions ?? sessions.length} session(s)`
  );

  if (activeInputSession) {
    pushRuntimeHubSectionHeading(lines, language === "en" ? "Current input session" : "Current input session");
    if (genericSessionLayout === "compact") {
      pushCompactRuntimeHubSession(lines, activeInputSession, null, {
        language,
        showMarkers: true
      });
    } else {
      pushRuntimeHubSession(lines, activeInputSession, null, {
        language,
        progressTextLimit: sessionProgressTextLimit,
        emphasizeMarkers: true,
        showMarkers: true
      });
    }
  }

  if (focusedSession) {
    pushRuntimeHubSectionHeading(lines,
      sessionCollectionKind === "running"
        ? (language === "en" ? "Focused running session" : "Viewing the running sessions")
        : (language === "en" ? "Focused session" : "Viewed Session")
    );
    if (genericSessionLayout === "compact") {
      pushCompactRuntimeHubSession(lines, focusedSession, 1, {
        language,
        showMarkers: true
      });
    } else {
      pushRuntimeHubSession(lines, focusedSession, 1, {
        language,
        progressTextLimit: sessionProgressTextLimit,
        emphasizeMarkers: true,
        showMarkers: true
      });
    }

    appendExpandedHubPlanSection(lines, {
      language,
      entries: options.planEntries,
      expanded: options.planExpanded,
      entryLimit: hubPlanEntryLimit,
      entryTextLimit: hubPlanEntryTextLimit
    });

    appendExpandedHubAgentSection(lines, {
      language,
      entries: options.agentEntries,
      expanded: options.agentsExpanded,
      entryLimit: hubAgentEntryLimit,
      entryProgressTextLimit: hubAgentProgressTextLimit
    });
  }

  if (otherSessions.length > 0 || hiddenOtherSessionCount > 0) {
    pushRuntimeHubSectionHeading(lines,
      sessionCollectionKind === "running"
        ? (language === "en" ? "Other running sessions" : "Other Running Sessions")
        : (language === "en" ? "Other sessions" : "OtherSessions")
    );
    for (const [index, session] of otherSessions.entries()) {
      if (genericSessionLayout === "compact") {
        pushCompactRuntimeHubSession(lines, session, index + (focusedSession ? 2 : 1), {
          language,
          showMarkers: true
        });
      } else {
        pushRuntimeHubSession(lines, session, index + 2, {
          language,
          progressTextLimit: sessionProgressTextLimit,
          emphasizeMarkers: false,
          showMarkers: true
        });
      }
    }

    if (hiddenOtherSessionCount > 0) {
      lines.push(language === "en"
        ? `... ${hiddenOtherSessionCount} more sessions not shown`
        : `... and ${hiddenOtherSessionCount} more session(s) hidden`);
    }
  }

  if (options.isMainHub && (options.terminalSummaries?.length ?? 0) > 0) {
    pushRuntimeHubSectionHeading(lines, language === "en" ? "Recent terminal sessions" : "Recently Completed");

    for (const [index, summary] of (options.terminalSummaries ?? []).entries()) {
      pushRuntimeHubTerminalSummary(lines, summary, index + 1, language);
    }
  }

  if (options.reminderText) {
    lines.push("", escapeHtml(options.reminderText));
  }
  lines.push("", buildRuntimeHubFooter(language));
  return lines.join("\n");
}

function buildRuntimeHubHeading(summary: string): string {
  return `🎯 <b>Active Hub</b> [${escapeHtml(summary)}]`;
}

function pushRuntimeHubSectionHeading(lines: string[], label: string): void {
  lines.push("", `<b>[${escapeHtml(label)}]</b>`);
}

function appendExpandedPlanSection(
  lines: string[],
  options: {
    language: UiLanguage;
    entries: string[] | undefined;
    expanded: boolean | undefined;
    entryLimit: number;
    entryTextLimit: number;
  }
): void {
  if (!options.expanded || !options.entries || options.entries.length === 0) {
    return;
  }

  lines.push("", `<b>${options.language === "en" ? "Plan:" : "Plan:"}</b>`);

  for (const [index, entry] of options.entries.slice(0, options.entryLimit).entries()) {
    lines.push(`${index + 1}. ${renderInlineMarkdown(truncateText(entry, options.entryTextLimit))}`);
  }

  if (options.entries.length > options.entryLimit) {
    lines.push(options.language === "en"
      ? `... ${options.entries.length - options.entryLimit} more steps`
      : `... and ${options.entries.length - options.entryLimit} more step(s)`);
  }
}

function appendExpandedAgentSection(
  lines: string[],
  options: {
    language: UiLanguage;
    entries: CollabAgentStateSnapshot[] | undefined;
    expanded: boolean | undefined;
    entryLimit: number;
    entryProgressTextLimit: number;
  }
): void {
  if (!options.expanded || !options.entries || options.entries.length === 0) {
    return;
  }

  lines.push("", `<b>${options.language === "en" ? "Agents:" : "Agent:"}</b>`);

  for (const [index, entry] of options.entries.slice(0, options.entryLimit).entries()) {
    lines.push(renderAgentRuntimeLine(entry, index + 1, options.entryProgressTextLimit));
  }

  if (options.entries.length > options.entryLimit) {
    lines.push(options.language === "en"
      ? `... ${options.entries.length - options.entryLimit} more agents`
      : `... and ${options.entries.length - options.entryLimit} more agent(s)`);
  }
}

function appendExpandedHubPlanSection(
  lines: string[],
  options: {
    language: UiLanguage;
    entries: string[] | undefined;
    expanded: boolean | undefined;
    entryLimit: number;
    entryTextLimit: number;
  }
): void {
  if (!options.expanded || !options.entries || options.entries.length === 0) {
    return;
  }

  pushRuntimeHubSectionHeading(lines, options.language === "en" ? "Plan Details" : "PlanInspect");

  for (const [index, entry] of options.entries.slice(0, options.entryLimit).entries()) {
    lines.push(renderHubPlanEntryLine(entry, index + 1, options.language, options.entryTextLimit));
  }

  if (options.entries.length > options.entryLimit) {
    lines.push(options.language === "en"
      ? `... ${options.entries.length - options.entryLimit} more plan items`
      : `... and ${options.entries.length - options.entryLimit} more plan item(s)`);
  }
}

function appendExpandedHubAgentSection(
  lines: string[],
  options: {
    language: UiLanguage;
    entries: CollabAgentStateSnapshot[] | undefined;
    expanded: boolean | undefined;
    entryLimit: number;
    entryProgressTextLimit: number;
  }
): void {
  if (!options.expanded || !options.entries || options.entries.length === 0) {
    return;
  }

  pushRuntimeHubSectionHeading(lines, options.language === "en" ? "Collab Agents" : "Collab Agents");

  for (const entry of options.entries.slice(0, options.entryLimit)) {
    lines.push(renderHubAgentDetailLine(entry, options.language, options.entryProgressTextLimit));
  }

  if (options.entries.length > options.entryLimit) {
    lines.push(options.language === "en"
      ? `... ${options.entries.length - options.entryLimit} more agents`
      : `... and ${options.entries.length - options.entryLimit} more agent(s)`);
  }
}

function pushRuntimeHubSession(
  lines: string[],
  session: RuntimeHubSessionView,
  index: number | null,
  options: {
    language: UiLanguage;
    progressTextLimit: number;
    emphasizeMarkers: boolean;
    showMarkers: boolean;
  }
): void {
  const markers = options.showMarkers
    ? [
      session.isFocused ? (options.language === "en" ? "Viewing" : "Viewing") : null,
      session.isActiveInputTarget ? (options.language === "en" ? "Current input" : "Current input") : null
    ].filter((value): value is string => Boolean(value))
    : [];
  const markerText = !options.emphasizeMarkers && markers.length > 0
    ? ` · ${markers.map((marker) => escapeHtml(marker)).join(" · ")}`
    : "";
  const displayIndex = session.slot ?? index;
  const statePrefix = options.language === "en" ? "State" : "Status";
  const folderLine = buildRuntimeHubFolderLine(session.sessionName, session.projectName);

  lines.push(HUB_SECTION_DIVIDER);
  lines.push(`${buildRuntimeHubStateBadge(session.state)} <b>${buildRuntimeHubSessionLabel(session.sessionName, displayIndex)}</b>`);

  if (folderLine) {
    lines.push(folderLine);
  }

  lines.push(`<i>(${statePrefix}: ${escapeHtml(session.state)}${markerText})</i>`);

  if (options.emphasizeMarkers && markers.length > 0) {
    lines.push(`<i>(${markers.map((marker) => escapeHtml(marker)).join(" · ")})</i>`);
  }

  if (session.progressText && options.progressTextLimit > 0) {
    lines.push("<b>[Runtime Preview]</b>");
    lines.push(`<blockquote expandable>${renderInlineMarkdown(truncateText(session.progressText, options.progressTextLimit))}</blockquote>`);
  }
}

function pushCompactRuntimeHubSession(
  lines: string[],
  session: RuntimeHubSessionView,
  index: number | null,
  options: {
    language: UiLanguage;
    showMarkers: boolean;
  }
): void {
  const markers = options.showMarkers
    ? [
      session.isFocused ? (options.language === "en" ? "Viewing" : "Viewing") : null,
      session.isActiveInputTarget ? (options.language === "en" ? "Current input" : "Current input") : null
    ].filter((value): value is string => Boolean(value))
    : [];
  const displayIndex = session.slot ?? index;
  const metaParts: string[] = [];
  const folderMeta = buildRuntimeHubFolderMeta(session.sessionName, session.projectName);

  if (folderMeta) {
    metaParts.push(folderMeta);
  }
  metaParts.push(`${options.language === "en" ? "State" : "Status"}: ${escapeHtml(session.state)}`);
  for (const marker of markers) {
    metaParts.push(escapeHtml(marker));
  }

  lines.push(HUB_SECTION_DIVIDER);
  lines.push(`${buildRuntimeHubStateBadge(session.state)} <b>${buildRuntimeHubSessionLabel(session.sessionName, displayIndex)}</b>`);
  lines.push(`<i>(${metaParts.join(" · ")})</i>`);
}

function buildRuntimeSurfaceFooter(language: UiLanguage): string {
  return language === "en"
    ? "💡 Tip: Use /inspect for full details. Use /interrupt to stop the current turn. Use /status for runtime details."
    : "💡 Tip: Use /inspect for details, /interrupt to stop, /status for status.";
}

function buildRuntimeHubFooter(_language: UiLanguage): string {
  return "💡 <i>/status | /inspect | /interrupt</i>";
}

function buildRuntimeHubSessionLabel(sessionName: string, displayIndex: number | null | undefined): string {
  const escapedSessionName = escapeHtml(sessionName);
  return displayIndex === null || displayIndex === undefined
    ? `SESSION: ${escapedSessionName}`
    : `SESSION #${displayIndex}: ${escapedSessionName}`;
}

function buildRuntimeHubFolderMeta(sessionName: string, projectName?: string | null): string | null {
  const trimmedProjectName = projectName?.trim();
  if (!trimmedProjectName || trimmedProjectName === sessionName.trim()) {
    return null;
  }
  return `Folder: ${escapeHtml(trimmedProjectName)}`;
}

function buildRuntimeHubFolderLine(sessionName: string, projectName?: string | null): string | null {
  const folderMeta = buildRuntimeHubFolderMeta(sessionName, projectName);
  return folderMeta ? `<i>(${folderMeta})</i>` : null;
}

function buildRuntimeHubStateBadge(state: string): string {
  const normalized = state.trim().toLowerCase();

  if (/(completed|Done|archived)/u.test(normalized)) {
    return "🏁";
  }
  if (/(failed|Failed|interrupted|Stopped)/u.test(normalized)) {
    return "⛔";
  }
  if (/(running|Running|starting|Preparing|reconnecting)/u.test(normalized)) {
    return "🟢";
  }
  return "🟡";
}

function pushRuntimeHubTerminalSummary(
  lines: string[],
  summary: RuntimeHubTerminalSummaryView,
  index: number,
  language: UiLanguage
): void {
  const folderLine = buildRuntimeHubFolderLine(summary.sessionName, summary.projectName);
  const stateLabel = language === "en" ? "State" : "Status";

  lines.push(HUB_SECTION_DIVIDER);
  lines.push(`${buildRuntimeHubStateBadge(summary.state)} <b>${index}. ${escapeHtml(summary.sessionName)}</b>`);
  if (folderLine) {
    lines.push(folderLine);
  }
  lines.push(`<i>(${stateLabel}: ${escapeHtml(summary.state)})</i>`);
}

export function buildRuntimeHubReplyMarkup(options: {
  token: string;
  callbackVersion: number;
  language?: UiLanguage;
  sessions?: RuntimeHubSessionView[];
  slotSessionIds?: Array<string | null>;
  focusedSessionId: string | null;
  planEntries?: string[];
  planExpanded?: boolean;
  agentEntries?: CollabAgentStateSnapshot[];
  agentsExpanded?: boolean;
  bridgeActions?: Array<{ command: "cancel" | "hub" | "status" | "inspect" | "interrupt" | "commands"; style?: "default" | "primary" }>;
}): TelegramInlineKeyboardMarkup {
  const language = options.language ?? "zh";
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];

  if (options.slotSessionIds) {
    const slotSessionIds = options.slotSessionIds.slice(0, 5);
    while (slotSessionIds.length < 5) {
      slotSessionIds.push(null);
    }

    rows.push(slotSessionIds.map((sessionId, index) => {
      const style: TelegramInlineKeyboardButton["style"] = sessionId && sessionId === options.focusedSessionId
        ? "primary"
        : "default";
      return {
        text: sessionId ? String(index + 1) : "·",
        callback_data: encodeHubSelectCallback(options.token, options.callbackVersion, index + 1),
        style
      };
    }));
  } else {
    const sessions = options.sessions ?? [];
    if (sessions.length > 1) {
      const sessionButtons = sessions.map((session, index) => {
        const style: TelegramInlineKeyboardButton["style"] = session.sessionId === options.focusedSessionId
          ? "primary"
          : "default";
        return {
          text: session.isFocused
            ? `${language === "en" ? "Viewing" : "Viewing"} · ${truncateText(session.sessionName, 18)}`
            : session.isActiveInputTarget
              ? `${language === "en" ? "Current" : "Current"} · ${truncateText(session.sessionName, 18)}`
              : truncateText(session.sessionName, 18),
          callback_data: encodeHubSelectCallback(options.token, options.callbackVersion, index),
          style
        };
      });
      rows.push(...chunkButtons(sessionButtons, 2));
    }
  }

  appendHubSecondaryButtons(
    rows,
    options.focusedSessionId,
    options.planEntries,
    options.planExpanded,
    options.agentEntries,
    options.agentsExpanded,
    language,
    options.bridgeActions
  );

  return { inline_keyboard: rows };
}

function appendHubSecondaryButtons(
  rows: TelegramInlineKeyboardMarkup["inline_keyboard"],
  focusedSessionId: string | null | undefined,
  planEntries: string[] | undefined,
  planExpanded: boolean | undefined,
  agentEntries: CollabAgentStateSnapshot[] | undefined,
  agentsExpanded: boolean | undefined,
  language: UiLanguage,
  bridgeActions?: Array<{ command: "cancel" | "hub" | "status" | "inspect" | "interrupt" | "commands"; style?: "default" | "primary" }>
): void {
  const buttons: TelegramInlineKeyboardMarkup["inline_keyboard"][number] = [];

  if (focusedSessionId && (planEntries?.length ?? 0) > 0) {
    buttons.push({
      text: planExpanded
        ? (language === "en" ? "Hide Plan" : "Collapse Plan")
        : buildCollapsedPlanButtonLabel(planEntries ?? [], language),
      callback_data: planExpanded
        ? encodePlanCollapseCallback(focusedSessionId)
        : encodePlanExpandCallback(focusedSessionId)
    });
  }

  if (focusedSessionId && (agentEntries?.length ?? 0) > 0) {
    buttons.push({
      text: agentsExpanded
        ? (language === "en" ? "Hide Agents" : "Hide Agents")
        : buildCollapsedAgentButtonLabel(agentEntries ?? [], language),
      callback_data: agentsExpanded
        ? encodeAgentCollapseCallback(focusedSessionId)
        : encodeAgentExpandCallback(focusedSessionId)
    });
  }

  if (buttons.length > 0) {
    rows.push(buttons);
  }

  if (bridgeActions && bridgeActions.length > 0) {
    rows.push(...buildBridgeCommandActionRows(bridgeActions, language, { chunkSize: 2 }));
    return;
  }

  rows.push([{
    text: language === "en" ? "Commands" : "Command",
    callback_data: encodeCommandPanelOpenCallback()
  }]);
}

export function buildRuntimeStatusFieldLabel(field: RuntimeStatusField): string {
  switch (field) {
    case "model-name":
      return "Model";
    case "model-with-reasoning":
      return "Model + Reasoning Effort";
    case "current-dir":
      return "CurrentDirectory";
    case "project-root":
      return "Project Root";
    case "git-branch":
      return "Git Branch";
    case "context-remaining":
      return "Remaining Context";
    case "context-used":
      return "Used Context";
    case "five-hour-limit":
      return "5-Hour Quota";
    case "weekly-limit":
      return "Weekly Quota";
    case "codex-version":
      return "Codex Version";
    case "context-window-size":
      return "Context Window Size";
    case "used-tokens":
      return "Used Tokens";
    case "total-input-tokens":
      return "Total Input Tokens";
    case "total-output-tokens":
      return "Total Output Tokens";
    case "session-id":
      return "Sessions ID";
    case "session_name":
      return "Session Name";
    case "project_name":
      return "Project name";
    case "project_path":
      return "Project Path (Legacy)";
    case "plan_mode":
      return "Plan mode";
    case "model_reasoning":
      return "Model + Effort (Legacy)";
    case "thread_id":
      return "Thread ID (Legacy)";
    case "turn_id":
      return "Turn ID";
    case "blocked_reason":
      return "Blocked Reason";
    case "current_step":
      return "Current Step";
    case "last_token_usage":
      return "Tokens This Turn";
    case "total_token_usage":
      return "Total Tokens";
    case "context_window":
      return "Context Window";
    case "final_answer_ready":
      return "Final Answer Ready";
  }
}

export function buildRuntimePreferencesAppliedMessage(fields: RuntimeStatusField[]): string {
  const summary = fields.length > 0
    ? fields.map((field) => buildRuntimeStatusFieldLabel(field)).join(", ")
    : "None";

  return [
    "<b>Applied Runtime Card Fields</b>",
    formatHtmlField("Current fields:", summary)
  ].join("\n");
}

export function buildRuntimePreferencesClosedMessage(fields: RuntimeStatusField[]): string {
  const summary = fields.length > 0
    ? fields.map((field) => buildRuntimeStatusFieldLabel(field)).join(", ")
    : "None";

  return [
    formatHtmlHeading("Closed Runtime Card Field Selection"),
    formatHtmlField("Current fields:", summary)
  ].join("\n");
}

export function buildRuntimePreferencesMessage(options: RuntimePreferencesView): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const pages = buildRuntimePreferencePages();
  const totalPages = Math.max(1, pages.length);
  const safePage = Math.min(Math.max(options.page, 0), totalPages - 1);
  const currentPage = pages[safePage] ?? {
    groupLabel: "Codex CLI",
    groupPage: 0,
    groupPageCount: 1,
    fields: [...CODEX_CLI_RUNTIME_STATUS_FIELDS].slice(0, RUNTIME_FIELD_PAGE_SIZE)
  };
  const pageFields = currentPage.fields;
  const selectedSet = new Set(options.fields);

  const selectedSummary = options.fields.length > 0
    ? options.fields.map((field, index) => `${index + 1}. ${buildRuntimeStatusFieldLabel(field)}`).join("\n")
    : "No fields selected.";

  const rows = pageFields.map((field) => [{
    text: `${selectedSet.has(field) ? "✓" : "+"} ${buildRuntimeStatusFieldLabel(field)}`,
    callback_data: encodeRuntimeToggleCallback(options.token, field)
  }]);

  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    navigation.push({ text: "Previous", callback_data: encodeRuntimePageCallback(options.token, safePage - 1) });
  }
  if (safePage + 1 < totalPages) {
    navigation.push({ text: "Next", callback_data: encodeRuntimePageCallback(options.token, safePage + 1) });
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }

  rows.push([{ text: "Save & Apply", callback_data: encodeRuntimeSaveCallback(options.token) }]);
  rows.push([{ text: "ResumeDefault", callback_data: encodeRuntimeResetCallback(options.token) }]);
  rows.push([{ text: "Close", callback_data: encodeRuntimeCloseCallback(options.token) }]);

  return {
    text: [
      formatHtmlHeading("Runtime Card Fields"),
      "Click buttons to select fields to display.",
      "Selection order determines display order. Newly selected fields will be appended.",
      formatHtmlField("Codex CLI: ", buildRuntimeStatusFieldGroupSummary(SELECTABLE_CODEX_CLI_RUNTIME_STATUS_FIELDS)),
      formatHtmlField("Bridge Extensions: ", buildRuntimeStatusFieldGroupSummary(BRIDGE_EXTENSION_RUNTIME_STATUS_FIELDS)),
      formatHtmlField("Current group:", currentPage.groupLabel),
      formatHtmlField("Selected:", `${options.fields.length}`),
      selectedSummary,
      formatHtmlField("Group page:", `${currentPage.groupPage + 1}/${currentPage.groupPageCount}`),
      formatHtmlField("Total page:", `${safePage + 1}/${totalPages}`)
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: rows
    }
  };
}

export function buildInspectViewMessage(options: RuntimeInspectView & RuntimeInspectControlsView): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
  totalPages: number;
} {
  const pages = paginateInspectHtml(options.html);
  const safePage = Math.min(Math.max(options.page, 0), pages.length - 1);

  if (options.collapsed) {
    return {
      text: buildCollapsedInspectText(options.html),
      replyMarkup: {
        inline_keyboard: [[
          {
            text: "Expand Inspect",
            callback_data: encodeInspectExpandCallback(options.sessionId, safePage)
          },
          {
            text: "Command",
            callback_data: encodeCommandPanelOpenCallback()
          },
          {
            text: "Close",
            callback_data: encodeInspectCloseCallback(options.sessionId)
          }
        ]]
      },
      totalPages: pages.length
    };
  }

  const buttons: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    buttons.push({ text: "Previous", callback_data: encodeInspectPageCallback(options.sessionId, safePage - 1) });
  }
  if (safePage + 1 < pages.length) {
    buttons.push({ text: "Next", callback_data: encodeInspectPageCallback(options.sessionId, safePage + 1) });
  }

  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  if (buttons.length > 0) {
    rows.push(buttons);
  }
  rows.push([
    { text: "Collapse Inspect", callback_data: encodeInspectCollapseCallback(options.sessionId) },
    { text: "Command", callback_data: encodeCommandPanelOpenCallback() },
    { text: "Close", callback_data: encodeInspectCloseCallback(options.sessionId) }
  ]);

  return {
    text: `${pages[safePage]}\n\n${formatHtmlField("Inspect page: ", `${safePage + 1}/${pages.length}`)}`,
    replyMarkup: {
      inline_keyboard: rows
    },
    totalPages: pages.length
  };
}

export function buildRollbackPickerMessage(options: RollbackPickerView): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
  totalPages: number;
} {
  const totalPages = Math.max(1, Math.ceil(options.targets.length / ROLLBACK_TARGET_PAGE_SIZE));
  const safePage = Math.min(Math.max(options.page, 0), totalPages - 1);
  const pageTargets = options.targets.slice(safePage * ROLLBACK_TARGET_PAGE_SIZE, (safePage + 1) * ROLLBACK_TARGET_PAGE_SIZE);
  const rows = pageTargets.map((target) => [{
    text: `${target.sequenceNumber}. ${truncateText(target.label, 24)}`,
    callback_data: encodeRollbackPickCallback(options.sessionId, safePage, target.index)
  }]);

  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    navigation.push({ text: "Previous", callback_data: encodeRollbackPageCallback(options.sessionId, safePage - 1) });
  }
  if (safePage + 1 < totalPages) {
    navigation.push({ text: "Next", callback_data: encodeRollbackPageCallback(options.sessionId, safePage + 1) });
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }
  rows.push([{ text: "Close", callback_data: encodeRollbackCloseCallback(options.sessionId) }]);

  const lines = [
    formatHtmlHeading("Select Rollback Target"),
    "Show user input only, hide agent output.",
    formatHtmlField("Page: ", `${safePage + 1}/${totalPages}`)
  ];

  pageTargets.forEach((target) => {
    lines.push(`${target.sequenceNumber}. ${escapeHtml(target.label)}`);
  });

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: rows
    },
    totalPages
  };
}

export function buildRollbackConfirmMessage(options: RollbackConfirmView): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  return {
    text: [
      formatHtmlHeading("Confirm Rollback"),
      formatHtmlField("Target: ", `${options.target.sequenceNumber}. ${options.target.label}`),
      formatHtmlField("Turns to delete:", `${options.target.rollbackCount}`),
      "Local file changes will not be automatically undone."
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: "Confirm Rollback", callback_data: encodeRollbackConfirmCallback(options.sessionId, options.target.index) }],
        [{ text: "Back to List", callback_data: encodeRollbackBackCallback(options.sessionId, options.page) }],
        [{ text: "Close", callback_data: encodeRollbackCloseCallback(options.sessionId) }]
      ]
    }
  };
}

export function buildRollbackClosedMessage(): string {
  return [
    formatHtmlHeading("Closed Rollback Target Selection"),
    "Rollback not executed."
  ].join("\n");
}

export function buildInspectClosedMessage(): string {
  return [
    formatHtmlHeading("Closed Active Inspect"),
    "Send /inspect again to reopen."
  ].join("\n");
}

export function buildRuntimeErrorCard(
  options: RuntimeCardContext & {
    title: string;
    detail?: string | null;
  }
): string {
  const lines: string[] = [formatHtmlHeading("Error")];
  pushHtmlRuntimeCardContext(lines, options);
  if (options.projectName && options.projectName !== options.sessionName) {
    lines.push(formatHtmlField("Project:", options.projectName));
  }
  lines.push(formatHtmlField("Title:", truncateText(options.title, 200)));

  if (options.detail) {
    lines.push(formatHtmlField("Detail:", truncateText(options.detail, 240)));
  }

  return lines.join("\n");
}

function appendInteractionHubHint(lines: string[], hubHint?: string | null): void {
  if (!hubHint) {
    return;
  }

  lines.push("", escapeHtml(hubHint));
}

function appendBridgeActionRows(
  rows: TelegramInlineKeyboardMarkup["inline_keyboard"],
  actions: readonly { command: "cancel" | "hub" | "status" | "inspect" | "interrupt" | "commands"; style?: "default" | "primary" }[] | undefined,
  language: UiLanguage,
  options?: {
    chunkSize?: number;
  }
): void {
  if (!actions || actions.length === 0) {
    return;
  }

  rows.push(...buildBridgeCommandActionRows(actions, language, options));
}

export function buildInteractionApprovalCard(options: InteractionApprovalCardRenderView): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const language: UiLanguage = "zh";
  const lines = [formatHtmlHeading(options.title), formatHtmlField("Type:", options.subtitle)];
  if (options.body) {
    lines.push(formatHtmlField("Content: ", options.body));
  }
  if (options.detail) {
    lines.push(formatHtmlField("Note: ", options.detail));
  }
  appendInteractionHubHint(lines, options.hubHint);

  const actionRow = options.actions.map((action, index) => ({
    text: action.text,
    callback_data: encodeInteractionDecisionCallback(options.interactionId, index)
  }));

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: (() => {
        const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [
        actionRow,
        [{ text: "Cancel this interaction", callback_data: encodeInteractionCancelCallback(options.interactionId) }]
        ];
        appendBridgeActionRows(rows, options.bridgeActions, language, { chunkSize: 2 });
        return rows;
      })()
    }
  };
}

export function buildInteractionQuestionCard(options: InteractionQuestionCardRenderView): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const language: UiLanguage = "zh";
  const lines = [
    formatHtmlHeading(options.title),
    formatHtmlField("Issues: ", `${options.questionIndex}/${options.totalQuestions}`),
    formatHtmlField("Title: ", options.header),
    escapeHtml(options.question)
  ];

  if (options.isSecret) {
    lines.push("<i>This answer will be treated as sensitive input and won't appear in visible summaries.</i>");
  }

  if (options.awaitingText) {
    lines.push("<i>Please type your text answer to this question directly.</i>");
    appendInteractionHubHint(lines, options.hubHint);
    return {
      text: lines.join("\n"),
      replyMarkup: {
        inline_keyboard: (() => {
          const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [
            [{ text: "Cancel this interaction", callback_data: encodeInteractionCancelCallback(options.interactionId) }]
          ];
          appendBridgeActionRows(rows, options.bridgeActions, language, { chunkSize: 2 });
          return rows;
        })()
      }
    };
  }

  if (!options.options || options.options.length === 0) {
    lines.push("<i>Click the button below, then type your answer in the chat.</i>");
    appendInteractionHubHint(lines, options.hubHint);
    return {
      text: lines.join("\n"),
      replyMarkup: {
        inline_keyboard: (() => {
          const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [
          [{ text: "Send Text Answer", callback_data: encodeInteractionTextCallback(options.interactionId, options.questionIndex - 1) }],
          [{ text: "Cancel this interaction", callback_data: encodeInteractionCancelCallback(options.interactionId) }]
          ];
          appendBridgeActionRows(rows, options.bridgeActions, language, { chunkSize: 2 });
          return rows;
        })()
      }
    };
  }

  for (const [index, option] of options.options.entries()) {
    lines.push(`${index + 1}. ${escapeHtml(option.label)}: ${escapeHtml(option.description)}`);
  }

  const optionButtons = options.options.map((option, index) => ({
    text: option.label,
    callback_data: encodeInteractionQuestionCallback(options.interactionId, options.questionIndex - 1, index)
  }));
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = chunkButtons(optionButtons, 2);

  if (options.isOther) {
    rows.push([
      {
        text: "Other",
        callback_data: encodeInteractionTextCallback(options.interactionId, options.questionIndex - 1)
      }
    ]);
  }

  rows.push([{ text: "Cancel this interaction", callback_data: encodeInteractionCancelCallback(options.interactionId) }]);
  appendBridgeActionRows(rows, options.bridgeActions, language, { chunkSize: 2 });
  appendInteractionHubHint(lines, options.hubHint);

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildInteractionResolvedCard(options: InteractionResolvedCardRenderView): {
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
} {
  const language: UiLanguage = "zh";
  const stateText = options.state === "answered"
    ? "Processed"
    : options.state === "canceled"
      ? "Cancelled"
      : "Processing failed";
  const lines = [
    formatHtmlHeading(options.title),
    formatHtmlField("Status: ", stateText)
  ];
  if (options.summary) {
    lines.push(formatHtmlField("Result: ", options.summary));
  }
  if (options.expanded && options.details && options.details.length > 0) {
    lines.push("", formatHtmlHeading("Submitted Answers"));
    for (const detail of options.details) {
      lines.push(escapeHtml(detail));
    }
  }
  appendInteractionHubHint(lines, options.hubHint);

  if (!options.expandable || !options.interactionId) {
    const rows = buildBridgeCommandActionRows(options.bridgeActions ?? [], language, { chunkSize: 2 });
    return rows.length > 0
      ? {
          text: lines.join("\n"),
          replyMarkup: { inline_keyboard: rows }
        }
      : { text: lines.join("\n") };
  }

  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [[{
    text: options.expanded ? "Less Submitted Answers" : "View Submitted Answers",
    callback_data: options.expanded
      ? encodeInteractionAnswerCollapseCallback(options.interactionId)
      : encodeInteractionAnswerExpandCallback(options.interactionId)
  }]];
  appendBridgeActionRows(rows, options.bridgeActions, language, { chunkSize: 2 });
  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: rows
    }
  };
}

export function buildInteractionExpiredCard(options: InteractionExpiredCardRenderView): {
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
} {
  const lines = [
    formatHtmlHeading(options.title),
    formatHtmlField("Status: ", "Expired")
  ];
  if (options.reason) {
    lines.push(formatHtmlField("Note: ", options.reason));
  }
  return { text: lines.join("\n") };
}

export function buildTurnStatusCard(
  status: ActivityStatus,
  context?: {
    sessionName?: string | null;
    projectName?: string | null;
  }
): string {
  const lines: string[] = [];

  if (context?.sessionName) {
    lines.push(`Session: ${context.sessionName}`);
  }

  if (context?.projectName) {
    lines.push(`Project: ${context.projectName}`);
  }

  lines.push(`Status: ${formatTurnStatus(status.turnStatus)}`);

  const blockedOn = formatBlockedReason(status.threadBlockedReason);
  if (blockedOn) {
    lines.push(`Blocked on: ${blockedOn}`);
  }

  lines.push(`Current step: ${describeCurrentStep(status)}`);

  const latestUpdate = getLatestStatusUpdate(status);
  if (latestUpdate) {
    lines.push(`Update: ${latestUpdate}`);
  } else if (status.latestProgress) {
    lines.push(`Latest progress: ${status.latestProgress}`);
  }

  const milestone = shouldShowMilestone(status, latestUpdate !== null) ? formatLatestMilestone(status) : null;
  if (milestone) {
    lines.push(`Latest milestone: ${milestone}`);
  }

  if (status.finalMessageAvailable) {
    lines.push("Final answer: ready");
  }

  lines.push("Use /inspect for full details. Use /interrupt to stop the current turn.");
  return lines.join("\n");
}

export function buildInspectText(
  snapshot: InspectSnapshot,
  options?: {
    debugFilePath?: string | null;
    sessionName?: string | null;
    projectName?: string | null;
    commands?: RuntimeCommandEntryView[];
    note?: string | null;
  }
): string {
  const lines = [formatHtmlHeading("Current Task Inspect")];

  if (options?.sessionName) {
    lines.push(formatHtmlField("Sessions: ", options.sessionName));
  }

  if (options?.projectName && options.projectName !== options.sessionName) {
    lines.push(formatHtmlField("Project: ", options.projectName));
  }

  lines.push(formatHtmlField("Status: ", formatInspectTurnStatus(snapshot.turnStatus)));

  const blockedOn = formatInspectBlockedReason(snapshot.threadBlockedReason);
  if (blockedOn) {
    lines.push(formatHtmlField("Blocked Reason: ", blockedOn));
  }

  lines.push(formatHtmlField("Current Action: ", describeInspectCurrentStep(snapshot)));

  if (snapshot.currentItemDurationSec !== null) {
    lines.push(formatHtmlField("Elapsed: ", formatDuration(snapshot.currentItemDurationSec)));
  }

  const conclusion = selectInspectConclusion(snapshot);
  if (conclusion) {
    lines.push(formatHtmlField("Latest Conclusion: ", conclusion));
  }

  if (snapshot.finalMessageAvailable) {
    lines.push(formatHtmlField("Final Response: ", "Ready"));
  }

  if (options?.note) {
    lines.push(formatHtmlField("Note: ", options.note));
  }

  const timelineLines = formatInspectTimelineSection(snapshot.recentTransitions);
  if (timelineLines.length > 0) {
    lines.push("", formatHtmlHeading("Recent Actions"));
    lines.push(...timelineLines);
  }

  const commandLines = formatInspectCommandSection(options?.commands ?? [], snapshot.recentCommandSummaries);
  if (commandLines.length > 0) {
    lines.push("", formatHtmlHeading("Recent Commands"));
    lines.push(...commandLines);
  }

  const fileChangeLines = formatInspectSummarySection(snapshot.recentFileChangeSummaries);
  if (fileChangeLines.length > 0) {
    lines.push("", formatHtmlHeading("Recent File Changes"));
    lines.push(...fileChangeLines);
  }

  const toolLines = formatInspectSummarySection([
    ...snapshot.recentMcpSummaries,
    ...snapshot.recentWebSearches
  ]);
  if (toolLines.length > 0) {
    lines.push("", formatHtmlHeading("Recent Tools & Search"));
    lines.push(...toolLines);
  }

  const hookLines = formatInspectSummarySection(snapshot.recentHookSummaries);
  if (hookLines.length > 0) {
    lines.push("", formatHtmlHeading("Recent Hooks"));
    lines.push(...hookLines);
  }

  const noticeLines = formatInspectSummarySection(
    [
      ...snapshot.recentNoticeSummaries,
      snapshot.terminalInteractionSummary
    ].filter((value): value is string => Boolean(value))
  );
  if (noticeLines.length > 0) {
    lines.push("", formatHtmlHeading("Tips & Warnings"));
    lines.push(...noticeLines);
  }

  const tokenUsageLines = formatTokenUsageSection(snapshot.tokenUsage);
  if (tokenUsageLines.length > 0) {
    lines.push("", formatHtmlHeading("Token Usage"));
    lines.push(...tokenUsageLines);
  }

  if (snapshot.latestDiffSummary) {
    lines.push("", formatHtmlHeading("Recent Diff"));
    lines.push(formatHtmlListItem(snapshot.latestDiffSummary));
  }

  const planLines = formatInspectSummarySection(snapshot.planSnapshot);
  if (planLines.length > 0) {
    lines.push("", formatHtmlHeading("Plan"));
    lines.push(...planLines);
  }

  const proposedPlanLines = formatInspectSummarySection(snapshot.proposedPlanSnapshot);
  if (proposedPlanLines.length > 0) {
    lines.push("", formatHtmlHeading("Plan Draft"));
    lines.push(...proposedPlanLines);
  }

  const commentaryLines = formatInspectSummarySection(snapshot.completedCommentary);
  if (commentaryLines.length > 0) {
    lines.push("", formatHtmlHeading("Additional Notes"));
    lines.push(...commentaryLines);
  }

  const pendingInteractionLines = formatPendingInteractionSection(snapshot.pendingInteractions);
  if (pendingInteractionLines.length > 0) {
    lines.push("", formatHtmlHeading("Pending Interactions"));
    lines.push(...pendingInteractionLines);
  }

  const answeredInteractionLines = formatInspectSummarySection(snapshot.answeredInteractions);
  if (answeredInteractionLines.length > 0) {
    lines.push("", formatHtmlHeading("Recent Answered"));
    lines.push(...answeredInteractionLines);
  }

  return lines.join("\n");
}

export function summarizePendingInteractionState(state: PendingInteractionState): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "awaiting_text":
      return "Waiting for text answer";
    case "answered":
      return "Processed";
    case "canceled":
      return "Cancelled";
    case "expired":
      return "Expired";
    case "failed":
      return "Processing failed";
    default:
      return state;
  }
}

function buildRuntimeStatusFieldGroupSummary(fields: readonly RuntimeStatusField[]): string {
  return fields.map((field) => buildRuntimeStatusFieldLabel(field)).join(", ");
}

const SELECTABLE_CODEX_CLI_RUNTIME_STATUS_FIELDS: readonly RuntimeStatusField[] = [
  "model-name",
  "model-with-reasoning",
  "current-dir",
  "project-root",
  "context-remaining",
  "context-used",
  "context-window-size",
  "used-tokens",
  "total-input-tokens",
  "total-output-tokens",
  "session-id"
] as const;

function buildRuntimePreferencePages(): Array<{
  groupLabel: string;
  groupPage: number;
  groupPageCount: number;
  fields: RuntimeStatusField[];
}> {
  const groups = [
    { groupLabel: "Codex CLI", fields: [...SELECTABLE_CODEX_CLI_RUNTIME_STATUS_FIELDS] },
    { groupLabel: "Bridge Extensions", fields: [...BRIDGE_EXTENSION_RUNTIME_STATUS_FIELDS] }
  ];

  return groups.flatMap(({ groupLabel, fields }) => {
    const groupPageCount = Math.max(1, Math.ceil(fields.length / RUNTIME_FIELD_PAGE_SIZE));
    return Array.from({ length: groupPageCount }, (_value, groupPage) => ({
      groupLabel,
      groupPage,
      groupPageCount,
      fields: fields.slice(groupPage * RUNTIME_FIELD_PAGE_SIZE, (groupPage + 1) * RUNTIME_FIELD_PAGE_SIZE)
    }));
  });
}

function buildCollapsedInspectText(html: string): string {
  const blocks = html.split("\n\n");
  const summary = blocks[0] ?? html;
  return `${summary}\n${formatHtmlField("Note: ", "Inspect collapsed. Click a button to expand.")}`;
}

function paginateInspectHtml(html: string): string[] {
  const blocks = html.split("\n\n");
  const summary = blocks[0] ?? html;
  const sections = blocks.slice(1);
  if (sections.length === 0) {
    return [html];
  }

  const sectionLengthLimit = Math.max(200, INSPECT_PAGE_CHAR_LIMIT - summary.length - 2);
  const normalizedSections = sections.flatMap((section) => splitOversizedInspectSection(section, sectionLengthLimit));
  const pages: string[] = [];
  let current = summary;

  for (const section of normalizedSections) {
    const candidate = `${current}\n\n${section}`;
    if (candidate.length <= INSPECT_PAGE_CHAR_LIMIT) {
      current = candidate;
      continue;
    }

    pages.push(current);
    current = `${summary}\n\n${section}`;
  }

  pages.push(current);
  return pages;
}

function splitOversizedInspectSection(section: string, maxLength: number): string[] {
  if (section.length <= maxLength) {
    return [section];
  }

  const lines = section.split("\n");
  const header = isStandaloneInspectHeading(lines[0] ?? "") ? lines[0] ?? null : null;
  const bodyLines = header ? lines.slice(1) : lines;
  if (bodyLines.length === 0) {
    return [section];
  }

  const chunks: string[] = [];
  const lineLengthLimit = Math.max(32, maxLength - (header ? header.length + 1 : 0));
  let currentLines = header ? [header] : [];

  for (const line of bodyLines) {
    const lineChunks = splitOversizedInspectLine(line, lineLengthLimit);
    for (const lineChunk of lineChunks) {
      const candidateLines = [...currentLines, lineChunk];
      const candidate = candidateLines.join("\n");
      if (candidate.length <= maxLength) {
        currentLines = candidateLines;
        continue;
      }

      if (currentLines.length > (header ? 1 : 0)) {
        chunks.push(currentLines.join("\n"));
      }
      currentLines = header ? [header, lineChunk] : [lineChunk];
    }
  }

  if (currentLines.length > (header ? 1 : 0)) {
    chunks.push(currentLines.join("\n"));
  }

  return chunks.length > 0 ? chunks : [section];
}

function splitOversizedInspectLine(line: string, maxLength: number): string[] {
  if (line.length <= maxLength) {
    return [line];
  }

  const { prefix, content } = splitInspectLinePrefix(line);
  const contentLengthLimit = Math.max(16, maxLength - prefix.length);
  if (!content || prefix.length >= maxLength) {
    return splitEscapedInspectText(line, maxLength);
  }

  return splitEscapedInspectText(content, contentLengthLimit).map((chunk) => `${prefix}${chunk}`);
}

function splitInspectLinePrefix(line: string): { prefix: string; content: string } {
  const patterns = [
    /^(\d+\.\s+<b>[^<]+<\/b>\s+)(.+)$/u,
    /^(-\s+<b>[^<]+<\/b>\s+)(.+)$/u,
    /^(\d+\.\s+)(.+)$/u,
    /^(-\s+)(.+)$/u,
    /^(<b>[^<]+<\/b>\s+)(.+)$/u
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      return {
        prefix: match[1] ?? "",
        content: match[2] ?? ""
      };
    }
  }

  return {
    prefix: "",
    content: line
  };
}

function splitEscapedInspectText(text: string, maxLength: number): string[] {
  const tokens = text.match(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);|\s+|./giu) ?? [text];
  const chunks: string[] = [];
  let current = "";

  for (const token of tokens) {
    if (current.length + token.length <= maxLength) {
      current += token;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current.trimEnd());
      current = token.trimStart();
      continue;
    }

    chunks.push(token);
  }

  if (current.length > 0) {
    chunks.push(current.trimEnd());
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function isStandaloneInspectHeading(line: string): boolean {
  return /^<b>[^<]+<\/b>$/u.test(line.trim());
}

function pushHtmlRuntimeCardContext(lines: string[], context: RuntimeCardContext, language: UiLanguage = "zh"): void {
  if (context.sessionName) {
    lines.push(formatRuntimeCardRow(language === "en" ? "Session" : "Sessions", context.sessionName));
  }
}

function formatRuntimeStatusOptionalField(line: string, language: UiLanguage): string {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    return escapeHtml(line);
  }

  const rawLabel = line.slice(0, separatorIndex).trim();
  const rawValue = line.slice(separatorIndex + 1).trimStart();
  if (!rawLabel) {
    return escapeHtml(line);
  }

  return formatRuntimeCardRow(
    language === "en" ? formatRuntimeStatusOptionalLabel(rawLabel) : formatRuntimeStatusOptionalLabelZh(rawLabel),
    rawValue
  );
}

function formatRuntimeStatusOptionalLabel(label: string): string {
  const uppercaseTokens = new Set(["api", "cli", "html", "id", "json", "mcp", "url", "uuid"]);
  return label
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (uppercaseTokens.has(lower)) {
        return lower.toUpperCase();
      }

      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function formatRuntimeStatusOptionalLabelZh(label: string): string {
  switch (label) {
    case "model-with-reasoning":
      return "Model";
    case "plan_mode":
      return "Plan Mode";
    case "current-dir":
      return "Directory";
    default:
      return formatRuntimeStatusOptionalLabel(label);
  }
}

function buildCollapsedPlanButtonLabel(_entries: string[], language: UiLanguage = "zh"): string {
  return language === "en" ? "Plan" : "Plan";
}

function buildCollapsedAgentButtonLabel(entries: CollabAgentStateSnapshot[], language: UiLanguage = "zh"): string {
  return language === "en"
    ? `Agents: ${entries.length} running`
    : `Agents: ${entries.length} running`;
}

function renderAgentRuntimeLine(entry: CollabAgentStateSnapshot, index: number, progressLimit = 160): string {
  const prefix = `${index}. ${escapeHtml(entry.label)} (${escapeHtml(formatAgentStatus(entry.status))})`;
  if (!entry.progress) {
    return prefix;
  }

  return `${prefix}: ${renderInlineMarkdown(truncateText(entry.progress, progressLimit))}`;
}

function selectCurrentPlanEntry(entries: string[]): string | null {
  return entries.find((entry) => /\(inProgress\)$/u.test(entry))
    ?? entries.find((entry) => /\((pending|todo)\)$/u.test(entry))
    ?? entries[0]
    ?? entries.at(-1)
    ?? null;
}

function stripPlanEntryStatus(entry: string): string {
  return entry
    .replace(/^\d+\.\s*/u, "")
    .replace(/^[-*]\s+/u, "")
    .replace(/\s+\((inProgress|pending|todo|completed|failed|blocked)\)$/u, "")
    .replace(/^#+\s*/u, "")
    .trim();
}

function renderHubPlanEntryLine(entry: string, index: number, language: UiLanguage, textLimit: number): string {
  const parsedStatus = parsePlanEntryStatus(entry);
  const renderedText = renderInlineMarkdown(truncateText(stripPlanEntryStatus(entry), textLimit));
  if (!parsedStatus) {
    return `${index}. ${renderedText}`;
  }

  return `${index}. <b>${escapeHtml(formatHubPlanStatus(parsedStatus, language))}</b> · ${renderedText}`;
}

function parsePlanEntryStatus(entry: string): "inProgress" | "completed" | "pending" | "todo" | "failed" | "blocked" | null {
  const match = entry.match(/\((inProgress|pending|todo|completed|failed|blocked)\)\s*$/u);
  return (match?.[1] as "inProgress" | "completed" | "pending" | "todo" | "failed" | "blocked" | null) ?? null;
}

function formatHubPlanStatus(
  status: "inProgress" | "completed" | "pending" | "todo" | "failed" | "blocked",
  language: UiLanguage
): string {
  switch (status) {
    case "inProgress":
      return language === "en" ? "In Progress" : "In Progress";
    case "completed":
      return language === "en" ? "Completed" : "Done";
    case "pending":
    case "todo":
      return language === "en" ? "Pending" : "Pending";
    case "failed":
      return language === "en" ? "Failed" : "Failed";
    case "blocked":
      return language === "en" ? "Blocked" : "BlockedMedium";
  }
}

function renderHubAgentDetailLine(
  entry: CollabAgentStateSnapshot,
  language: UiLanguage,
  progressLimit: number
): string {
  const progressText = entry.progress
    ? renderInlineMarkdown(truncateText(entry.progress, progressLimit))
    : escapeHtml(language === "en" ? "Waiting for status update" : "Waiting for status update");
  return `${buildHubAgentStatusBadge(entry.status)} <b>${escapeHtml(entry.label)}</b> · ${escapeHtml(formatHubAgentStatus(entry.status, language))} · ${progressText}`;
}

function buildHubAgentStatusBadge(status: CollabAgentStateSnapshot["status"]): string {
  switch (status) {
    case "running":
      return "🟢";
    case "completed":
      return "🏁";
    case "errored":
    case "notFound":
      return "⛔";
    case "pendingInit":
    case "shutdown":
    default:
      return "🟡";
  }
}

function formatHubAgentStatus(status: CollabAgentStateSnapshot["status"], language: UiLanguage): string {
  switch (status) {
    case "pendingInit":
      return language === "en" ? "Pending init" : "Pending Init";
    case "running":
      return language === "en" ? "Running" : "Running";
    case "completed":
      return language === "en" ? "Completed" : "Done";
    case "errored":
      return language === "en" ? "Errored" : "Error";
    case "shutdown":
      return language === "en" ? "Stopped" : "Stopped";
    case "notFound":
      return language === "en" ? "Not found" : "Not found";
    default:
      return status;
  }
}

function formatAgentStatus(status: CollabAgentStateSnapshot["status"]): string {
  switch (status) {
    case "pendingInit":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
      return "errored";
    case "shutdown":
      return "shutdown";
    case "notFound":
      return "not found";
    default:
      return status;
  }
}

function buildDetailedRuntimeCommandLines(
  command: RuntimeCommandEntryView,
  index: number | null
): string[] {
  const prefix = index === null ? "" : `${index}. `;
  const detailPrefix = index === null ? "" : "- ";
  const lines = [`${prefix}${formatHtmlField("Command: ", formatRuntimeCommandText(command.commandText))}`];
  lines.push(`${detailPrefix}${formatHtmlField("Status: ", formatInspectCommandState(command.state))}`);

  if (command.latestSummary) {
    lines.push(`${detailPrefix}${formatHtmlField("Result: ", truncateText(command.latestSummary, 220))}`);
  }

  if (command.cwd) {
    lines.push(`${detailPrefix}${formatHtmlField("Slot ", truncateText(command.cwd, 220))}`);
  }

  if (typeof command.exitCode === "number") {
    lines.push(`${detailPrefix}${formatHtmlField("Exit Code: ", `${command.exitCode}`)}`);
  }

  if (typeof command.durationMs === "number") {
    lines.push(`${detailPrefix}${formatHtmlField("Duration: ", formatCommandDuration(command.durationMs))}`);
  }

  return lines;
}

function formatInspectCommandSection(commands: RuntimeCommandEntryView[], fallbackSummaries: string[]): string[] {
  if (commands.length === 0) {
    return formatInspectSummarySection(fallbackSummaries);
  }

  return commands.flatMap((command, index) => buildDetailedRuntimeCommandLines(command, index + 1));
}

function formatPendingInteractionSection(snapshot: InspectSnapshot["pendingInteractions"]): string[] {
  return snapshot.map((interaction, index) => {
    const suffix = interaction.awaitingText ? ", Waiting for text answer" : "";
    return `${index + 1}. ${escapeHtml(interaction.interactionKind)} / ${escapeHtml(interaction.requestMethod)} / ${escapeHtml(summarizePendingInteractionState(interaction.state))}${suffix}`;
  });
}

function formatTokenUsageSection(tokenUsage: InspectSnapshot["tokenUsage"]): string[] {
  if (!tokenUsage) {
    return [];
  }

  const lines = [
    formatHtmlListItem(`This turn: ${tokenUsage.lastTotalTokens}(input ${tokenUsage.lastInputTokens}, output ${tokenUsage.lastOutputTokens}, cached ${tokenUsage.lastCachedInputTokens}, reasoning ${tokenUsage.lastReasoningOutputTokens})`),
    formatHtmlListItem(`Total: ${tokenUsage.totalTokens}(input ${tokenUsage.totalInputTokens}, output ${tokenUsage.totalOutputTokens}, cached ${tokenUsage.totalCachedInputTokens}, reasoning ${tokenUsage.totalReasoningOutputTokens})`)
  ];
  if (tokenUsage.modelContextWindow !== null) {
    lines.push(formatHtmlListItem(`Context Window: ${tokenUsage.modelContextWindow}`));
  }

  return lines;
}

function formatRuntimeCommandText(commandText: string): string {
  const trimmed = commandText.trim();
  if (trimmed.startsWith("$")) {
    return truncateText(trimmed, 220);
  }

  return truncateText(`$ ${trimmed}`, 220);
}

function formatInspectSummarySection(values: string[]): string[] {
  return values
    .filter((value) => value.trim().length > 0)
    .map((value) => formatHtmlListItem(value));
}

function formatInspectTimelineSection(transitions: InspectSnapshot["recentTransitions"]): string[] {
  return transitions
    .slice(-5)
    .reverse()
    .map((transition, index) => `${index + 1}. ${escapeHtml(`${formatRelativeTime(transition.at)}: ${translateInspectSummary(transition.summary)}`)}`);
}

function formatRuntimeCardRow(
  label: string,
  value: string,
  options: {
    valueIsHtml?: boolean;
  } = {}
): string {
  const renderedValue = options.valueIsHtml ? value : escapeHtml(value);
  return `${formatHtmlHeading(label)} · ${renderedValue}`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/gu, "");
}

function formatHtmlListItem(value: string): string {
  return `- ${escapeHtml(value)}`;
}

function formatInspectTurnStatus(status: ActivityStatus["turnStatus"]): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "starting":
      return "Preparing";
    case "running":
      return "Running";
    case "blocked":
      return "Waiting";
    case "interrupted":
      return "Stopped";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}

function formatInspectCommandState(state: string): string {
  switch (state.toLowerCase()) {
    case "running":
      return "In Progress";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Stopped";
    default:
      return "Unknown";
  }
}

function formatInspectBlockedReason(reason: ActivityStatus["threadBlockedReason"]): string | null {
  switch (reason) {
    case "waitingOnApproval":
      return "Waiting for approval";
    case "waitingOnUserInput":
      return "Awaiting Input";
    default:
      return null;
  }
}

function describeInspectCurrentStep(status: ActivityStatus): string {
  if (status.threadBlockedReason === "waitingOnApproval") {
    return "Waiting for approval";
  }

  if (status.threadBlockedReason === "waitingOnUserInput") {
    return "Awaiting Input";
  }

  switch (status.activeItemType) {
    case "planning":
      return "Updating plan";
    case "commandExecution":
      return appendSpecificLabel("Running command", status.activeItemLabel, ["command"], ": ");
    case "fileChange":
      return appendSpecificLabel("Modifying files", status.activeItemLabel, ["file changes"], ": ");
    case "mcpToolCall":
      return appendSpecificLabel("Calling MCP tool", status.activeItemLabel, ["MCP tool call"], ": ");
    case "webSearch":
      return appendSpecificLabel("Searching the web", status.activeItemLabel, ["web search"], ": ");
    case "agentMessage":
      return appendSpecificLabel("Preparing response", status.activeItemLabel, ["assistant response"], ": ");
    case "reasoning":
      return "Thinking";
    case "other":
      return appendSpecificLabel("Processing task", status.activeItemLabel, ["work item", "other"], ": ");
    default:
      return defaultInspectStepForStatus(status.turnStatus);
  }
}

function selectInspectConclusion(status: ActivityStatus): string | null {
  const latestUpdate = getLatestStatusUpdate(status);
  if (latestUpdate) {
    return latestUpdate;
  }

  if (status.latestProgress) {
    return status.latestProgress;
  }

  return formatInspectMilestone(status);
}

function translateInspectSummary(summary: string): string {
  if (summary === "turn started") {
    return "Starting execution";
  }

  const completedMatch = summary.match(/^turn completed \((.+)\)$/u);
  if (completedMatch) {
    return `Execution finished (${formatInspectTurnStatus(mapCompletionWord(completedMatch[1] ?? "unknown"))})`;
  }

  const blockedMatch = summary.match(/^thread blocked \((.+)\)$/u);
  if (blockedMatch) {
    return `Thread blocked (${translateBlockedToken(blockedMatch[1] ?? "")})`;
  }

  const statusMatch = summary.match(/^thread status (.+)$/u);
  if (statusMatch) {
    return `ThreadStatus: ${translateThreadStatusToken(statusMatch[1] ?? "")}`;
  }

  const startedMatch = summary.match(/^(.+) started$/u);
  if (startedMatch) {
    return `Started: ${startedMatch[1] ?? ""}`;
  }

  const itemCompletedMatch = summary.match(/^(.+) completed$/u);
  if (itemCompletedMatch) {
    return `Completed: ${itemCompletedMatch[1] ?? ""}`;
  }

  return summary;
}

function formatTurnStatus(status: ActivityStatus["turnStatus"]): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "blocked":
      return "Blocked";
    case "interrupted":
      return "Interrupted";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}

function formatBlockedReason(reason: ActivityStatus["threadBlockedReason"]): string | null {
  switch (reason) {
    case "waitingOnApproval":
      return "approval";
    case "waitingOnUserInput":
      return "user input";
    default:
      return null;
  }
}

function describeCurrentStep(status: ActivityStatus): string {
  if (status.threadBlockedReason === "waitingOnApproval") {
    return BLOCKED_PROGRESS_APPROVAL;
  }

  if (status.threadBlockedReason === "waitingOnUserInput") {
    return BLOCKED_PROGRESS_USER_INPUT;
  }

  switch (status.activeItemType) {
    case "planning":
      return "Updating the plan";
    case "commandExecution":
      return appendSpecificLabel("Running command", status.activeItemLabel, ["command"]);
    case "fileChange":
      return appendSpecificLabel("Editing files", status.activeItemLabel, ["file changes"]);
    case "mcpToolCall":
      return appendSpecificLabel("Calling MCP tool", status.activeItemLabel, ["MCP tool call"]);
    case "webSearch":
      return appendSpecificLabel("Searching the web", status.activeItemLabel, ["web search"]);
    case "agentMessage":
      return appendSpecificLabel("Drafting the response", status.activeItemLabel, ["assistant response"]);
    case "reasoning":
      return "Thinking";
    case "other":
      return appendSpecificLabel("Working on", status.activeItemLabel, ["work item", "other"]);
    default:
      return defaultStepForStatus(status.turnStatus);
  }
}

function appendSpecificLabel(base: string, label: string | null, genericLabels: string[], separator = ": "): string {
  if (!label || genericLabels.includes(label)) {
    return base;
  }

  return `${base}${separator}${label}`;
}

function defaultStepForStatus(status: ActivityStatus["turnStatus"]): string {
  switch (status) {
    case "starting":
      return "Waiting for first activity";
    case "running":
      return "Processing";
    case "blocked":
      return "Waiting";
    case "completed":
      return "No active step";
    case "interrupted":
      return "No active step";
    case "failed":
      return "No active step";
    case "idle":
      return "Ready";
    default:
      return "Waiting for activity";
  }
}

function defaultInspectStepForStatus(status: ActivityStatus["turnStatus"]): string {
  switch (status) {
    case "starting":
      return "Awaiting first activity";
    case "running":
      return "Processing";
    case "blocked":
      return "Awaiting continuation";
    case "completed":
      return "No steps in progress";
    case "interrupted":
      return "Stopped, no steps in progress";
    case "failed":
      return "Execution failed, no steps in progress";
    case "idle":
      return "No steps in progress";
    default:
      return "Awaiting activity";
  }
}

function formatLatestMilestone(status: ActivityStatus): string | null {
  if (!status.lastHighValueEventType || !status.lastHighValueTitle) {
    return null;
  }

  if (
    status.latestProgress &&
    status.lastHighValueEventType !== "done" &&
    status.lastHighValueEventType !== "blocked"
  ) {
    return null;
  }

  const value = buildMilestoneText(status);
  if (!value) {
    return null;
  }

  return status.latestProgress === value ? null : value;
}

function formatInspectMilestone(status: ActivityStatus): string | null {
  const title = status.lastHighValueTitle;
  if (!title) {
    return null;
  }

  switch (status.lastHighValueEventType) {
    case "ran_cmd": {
      const command = stripPrefix(title, "Ran cmd: ");
      return status.lastHighValueDetail
        ? `CommandResult: ${command} -> ${status.lastHighValueDetail}`
        : `Running command: ${command}`;
    }
    case "changed":
      return `File changes: ${status.lastHighValueDetail ?? stripPrefix(title, "Changed: ")}`;
    case "found":
      return `Found: ${status.lastHighValueDetail ?? stripPrefix(title, "Found: ")}`;
    case "blocked":
      return `Blocked: ${status.lastHighValueDetail ?? stripPrefix(title, "Blocked: ")}`;
    case "done":
      return status.lastHighValueDetail ? "Final response generated" : `Execution finished: ${stripPrefix(title, "Done: ")}`;
    default:
      return null;
  }
}

function shouldShowMilestone(status: ActivityStatus, hasRecentUpdates: boolean): boolean {
  if (!hasRecentUpdates) {
    return true;
  }

  return status.lastHighValueEventType === "done" || status.lastHighValueEventType === "blocked";
}

function getLatestStatusUpdate(status: ActivityStatus): string | null {
  return status.recentStatusUpdates.at(-1) ?? null;
}

function buildMilestoneText(status: ActivityStatus): string | null {
  const title = status.lastHighValueTitle;
  if (!title) {
    return null;
  }

  switch (status.lastHighValueEventType) {
    case "ran_cmd": {
      const command = stripPrefix(title, "Ran cmd: ");
      return status.lastHighValueDetail
        ? `Command result: ${command} -> ${status.lastHighValueDetail}`
        : `Command started: ${command}`;
    }
    case "changed":
      return `File change: ${status.lastHighValueDetail ?? stripPrefix(title, "Changed: ")}`;
    case "found":
      return `Discovery: ${status.lastHighValueDetail ?? stripPrefix(title, "Found: ")}`;
    case "blocked":
      return `Blocker: ${status.lastHighValueDetail ?? stripPrefix(title, "Blocked: ")}`;
    case "done":
      return status.lastHighValueDetail
        ? `Assistant reply: ${status.lastHighValueDetail}`
        : `Completion: ${stripPrefix(title, "Done: ")}`;
    default:
      return null;
  }
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (remainder === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${remainder}s`;
}

function formatCommandDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = Math.round((durationMs / 1000) * 10) / 10;
  return `${seconds}s`;
}

function mapCompletionWord(status: string): ActivityStatus["turnStatus"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

function translateBlockedToken(token: string): string {
  switch (token) {
    case "waitingOnApproval":
      return "Waiting for approval";
    case "waitingOnUserInput":
      return "Awaiting Input";
    default:
      return token;
  }
}

function translateThreadStatusToken(token: string): string {
  switch (token) {
    case "notLoaded":
      return "Not loaded";
    case "idle":
      return "Idle";
    case "active":
      return "Active";
    case "systemError":
      return "System error";
    default:
      return token;
  }
}
