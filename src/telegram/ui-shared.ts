import type { ReasoningEffort, SessionRow } from "../types.js";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatHtmlHeading(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

export function formatHtmlField(label: string, value: string): string {
  return `${formatHtmlHeading(label)} ${escapeHtml(value)}`;
}

export function chunkButtons<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function formatRelativeTime(isoTime: string): string {
  const diffMs = Math.max(0, Date.now() - Date.parse(isoTime));
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatReasoningEffortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case "none":
      return "Close";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Very high";
  }
}

export function formatSessionModelReasoningConfig(
  session: Pick<SessionRow, "selectedModel" | "selectedReasoningEffort">
): string {
  const modelLabel = session.selectedModel ?? "DefaultModel";
  const effortLabel = session.selectedReasoningEffort ? formatReasoningEffortLabel(session.selectedReasoningEffort) : "Default";
  return `${modelLabel} + ${effortLabel}`;
}
