import { classifyNotification } from "../codex/notification-classifier.js";
import type { BridgePlatform } from "../core/domain/binding.js";
import type { BridgeStateStore } from "../state/store.js";

type GlobalRuntimeNotice = Extract<
  ReturnType<typeof classifyNotification>,
  {
    kind:
      | "config_warning"
      | "deprecation_notice"
      | "model_rerouted"
      | "skills_changed"
      | "thread_compacted"
      | "thread_compaction_completed"
  }
>;

interface RuntimeNoticeBroadcasterDeps {
  getStore: () => BridgeStateStore | null;
  activePack: BridgePlatform;
  safeSendMessage: (chatId: string, text: string) => Promise<boolean>;
}

export class RuntimeNoticeBroadcaster {
  constructor(private readonly deps: RuntimeNoticeBroadcasterDeps) {}

  async broadcast(notification: GlobalRuntimeNotice): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const message = formatGlobalRuntimeNotice(notification);
    if (!message) {
      return;
    }

    const bindings = store.listChatBindings(this.deps.activePack);
    for (const binding of bindings) {
      const delivered = await this.deps.safeSendMessage(binding.chatId, message);
      if (!delivered) {
        store.createRuntimeNotice({
          chatId: binding.chatId,
          type: "app_server_notice",
          message
        });
      }
    }
  }
}

export function formatGlobalRuntimeNotice(notification: GlobalRuntimeNotice): string | null {
  switch (notification.kind) {
    case "config_warning":
      return notification.summary
        ? `Codex Config warning：${notification.summary}${notification.detail ? `\n${notification.detail}` : ""}`
        : null;
    case "deprecation_notice":
      return notification.summary
        ? `Codex Deprecation notice：${notification.summary}${notification.detail ? `\n${notification.detail}` : ""}`
        : null;
    case "model_rerouted":
      if (!notification.fromModel || !notification.toModel) {
        return null;
      }
      return `Codex rerouted model: ${notification.fromModel} -> ${notification.toModel}${notification.reason ? ` (${notification.reason})` : ""}`;
    case "skills_changed":
      return "Codex skills list refreshed.";
    case "thread_compacted":
    case "thread_compaction_completed":
      return "Codex thread context compacted.";
    default:
      return null;
  }
}
