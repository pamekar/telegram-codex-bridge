import type { PersistedTerminalResultRecord } from "../domain/records.js";
import type {
  RecentOutputEntryView,
  TerminalResultControlView,
  TerminalResultDeliveryView
} from "../interaction-model/terminal.js";

export function createTerminalResultDeliveryView(
  saved: PersistedTerminalResultRecord,
  truncated: boolean
): TerminalResultDeliveryView {
  const collapsible = truncated || saved.pages.length > 1;
  return {
    kind: saved.kind,
    html: collapsible
      ? saved.previewHtml
      : (saved.pages[0] ?? saved.previewHtml),
    controls: createTerminalResultControls(saved, { collapsible })
  };
}

export function createDeferredTerminalNoticeView(
  saved: PersistedTerminalResultRecord
): TerminalResultDeliveryView {
  if (saved.kind === "plan_result") {
    return {
      kind: "plan_result",
      html: "<i>Plan result not yet delivered. Click \u201cExpand Plan\u201d to re-render.</i>",
      controls: createTerminalResultControls(saved)
    };
  }

  return {
    kind: "final_answer",
    html: "<i>Final answer not yet delivered. Click \u201cExpand\u201d to re-render.</i>",
    controls: createTerminalResultControls(saved)
  };
}

export function createRecentOutputEntryView(options: RecentOutputEntryView): RecentOutputEntryView {
  return {
    ...(options.sessionName !== undefined ? { sessionName: options.sessionName } : {}),
    ...(options.projectName !== undefined ? { projectName: options.projectName } : {}),
    hasResult: options.hasResult
  };
}

export function createRecentOutputControlsView(
  saved: PersistedTerminalResultRecord,
  options?: {
    expanded?: boolean;
    currentPage?: number;
  }
): TerminalResultControlView {
  return createTerminalResultControls(saved, options);
}

function createTerminalResultControls(
  saved: PersistedTerminalResultRecord,
  options?: {
    collapsible?: boolean;
    expanded?: boolean;
    currentPage?: number;
  }
): TerminalResultControlView {
  return {
    answerId: saved.answerId,
    totalPages: saved.pages.length,
    collapsible: options?.collapsible ?? true,
    expanded: options?.expanded ?? false,
    ...(options?.currentPage !== undefined ? { currentPage: options.currentPage } : {}),
    primaryActionConsumed: saved.primaryActionConsumed
  };
}
