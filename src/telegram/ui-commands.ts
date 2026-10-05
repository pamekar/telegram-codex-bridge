import {
  getTelegramCommandPanelEntry,
  getTelegramCommandPanelGroups,
  type TelegramCommandPanelEntry
} from "./commands.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";
import type { UiLanguage } from "../types.js";
import {
  encodeCommandPanelEditCloseCallback,
  encodeCommandPanelEditHelpCallback,
  encodeCommandPanelEditOpenCallback,
  encodeCommandPanelEditPageCallback,
  encodeCommandPanelEditResetCallback,
  encodeCommandPanelEditSaveCallback,
  encodeCommandPanelEditToggleCallback,
  encodeCommandPanelOpenCallback,
  encodeCommandPanelRunCallback
} from "./ui-callbacks.js";
import { chunkButtons, formatHtmlField, formatHtmlHeading } from "./ui-shared.js";

export const COMMAND_PANEL_MAX_COMMANDS = 8;
const COMMAND_PANEL_PAGE_SIZE = 6;

interface CommandPanelEditPage {
  groupLabel: string;
  groupPage: number;
  groupPageCount: number;
  entries: TelegramCommandPanelEntry[];
}

export function resolveCommandPanelEntries(commands: string[], language: UiLanguage): TelegramCommandPanelEntry[] {
  return commands
    .map((command) => getTelegramCommandPanelEntry(command, language))
    .filter((entry): entry is TelegramCommandPanelEntry => Boolean(entry));
}

export function buildHelpReplyMarkup(language: UiLanguage): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[{
      text: language === "en" ? "Open Commands" : "Open Commands",
      callback_data: encodeCommandPanelOpenCallback()
    }]]
  };
}

export function buildCommandPanelMessage(options: {
  commands: TelegramCommandPanelEntry[];
  language: UiLanguage;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const rows = chunkButtons(options.commands.map((entry) => ({
    text: entry.shortLabel,
    callback_data: encodeCommandPanelRunCallback(entry.command)
  })), 2);

  rows.push([
    {
      text: options.language === "en" ? "Full Help" : "Full Help",
      callback_data: encodeCommandPanelEditHelpCallback()
    },
    {
      text: options.language === "en" ? "Edit Commands" : "Edit Quick Commands",
      callback_data: encodeCommandPanelEditOpenCallback()
    }
  ]);

  const lines = [
    formatHtmlHeading(options.language === "en" ? "Command Panel" : "Quick Commands"),
    options.language === "en"
      ? "Tap a button to run a bridge command."
      : "Click a button to execute a bridge command.",
    formatHtmlField(
      options.language === "en" ? "Selected:" : "CurrentQuick Commands：",
      `${options.commands.length}/${COMMAND_PANEL_MAX_COMMANDS}`
    )
  ];

  if (options.commands.length === 0) {
    lines.push(options.language === "en" ? "No quick commands configured yet." : "No quick commands configured yet.");
  } else {
    lines.push(...options.commands.map((entry, index) =>
      `${index + 1}. /${entry.command} ${entry.description}`
    ));
  }

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildCommandPanelEditMessage(options: {
  token: string;
  commands: string[];
  page: number;
  language: UiLanguage;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const pages = buildCommandPanelEditPages(options.language);
  const totalPages = Math.max(1, pages.length);
  const safePage = Math.min(Math.max(options.page, 0), totalPages - 1);
  const currentPage = pages[safePage] ?? {
    groupLabel: options.language === "en" ? "Commands" : "Quick Commands",
    groupPage: 0,
    groupPageCount: 1,
    entries: []
  };
  const selectedSet = new Set(options.commands);
  const selectedEntries = resolveCommandPanelEntries(options.commands, options.language);
  const selectedSummary = selectedEntries.length > 0
    ? selectedEntries.map((entry, index) => `${index + 1}. /${entry.command} ${entry.description}`).join("\n")
    : (options.language === "en" ? "No commands selected yet." : "No commands selected yet.");

  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = currentPage.entries.map((entry) => [{
    text: `${selectedSet.has(entry.command) ? "✓" : "＋"} ${entry.shortLabel}`,
    callback_data: encodeCommandPanelEditToggleCallback(options.token, entry.command)
  }]);

  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    navigation.push({
      text: options.language === "en" ? "Previous" : "Previous",
      callback_data: encodeCommandPanelEditPageCallback(options.token, safePage - 1)
    });
  }
  if (safePage + 1 < totalPages) {
    navigation.push({
      text: options.language === "en" ? "Next" : "Next",
      callback_data: encodeCommandPanelEditPageCallback(options.token, safePage + 1)
    });
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }

  rows.push([{ text: options.language === "en" ? "Save" : "Save", callback_data: encodeCommandPanelEditSaveCallback(options.token) }]);
  rows.push([{ text: options.language === "en" ? "Restore Default" : "ResumeDefault", callback_data: encodeCommandPanelEditResetCallback(options.token) }]);
  rows.push([{ text: options.language === "en" ? "Close" : "Close", callback_data: encodeCommandPanelEditCloseCallback(options.token) }]);

  return {
    text: [
      formatHtmlHeading(options.language === "en" ? "Edit Quick Commands" : "Edit Quick Commands"),
      options.language === "en"
        ? "Tap to select or remove commands. Selection order is display order."
        : "Click a button to select or remove. Selection order determines display order.",
      options.language === "en"
        ? "Selecting a new command appends it to the end."
        : "Newly selected commands will be appended to the end.",
      formatHtmlField(options.language === "en" ? "Current group:" : "Current group:", currentPage.groupLabel),
      formatHtmlField(options.language === "en" ? "Selected:" : "Selected:", `${options.commands.length}/${COMMAND_PANEL_MAX_COMMANDS}`),
      selectedSummary,
      formatHtmlField(options.language === "en" ? "Group page:" : "Group page:", `${currentPage.groupPage + 1}/${currentPage.groupPageCount}`),
      formatHtmlField(options.language === "en" ? "Total page:" : "Total page:", `${safePage + 1}/${totalPages}`)
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

function buildCommandPanelEditPages(language: UiLanguage): CommandPanelEditPage[] {
  const groups = getTelegramCommandPanelGroups(language);
  const pages: CommandPanelEditPage[] = [];

  for (const group of groups) {
    const totalPages = Math.max(1, Math.ceil(group.entries.length / COMMAND_PANEL_PAGE_SIZE));
    for (let page = 0; page < totalPages; page += 1) {
      pages.push({
        groupLabel: group.label,
        groupPage: page,
        groupPageCount: totalPages,
        entries: group.entries.slice(page * COMMAND_PANEL_PAGE_SIZE, (page + 1) * COMMAND_PANEL_PAGE_SIZE)
      });
    }
  }

  return pages;
}
