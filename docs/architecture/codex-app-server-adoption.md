<!-- docmeta
role: leaf
layer: 3
parent: docs/architecture/README.md
children: []
summary: current bridge-owned Codex app-server adoption boundary, including lifecycle, request families, server-request handling, and notification reduction
read_when:
  - the task is about what Codex app-server methods this repository actually uses today
  - the task is about the bridge-side app-server lifecycle, approval handling, or notification reduction
  - protocol capability and current implementation need to be kept separate
skip_when:
  - the task is only about raw protocol availability with no repository-specific behavior
  - the task is only about user-facing Telegram command copy
source_of_truth:
  - src/codex/app-server.ts
  - src/service/turn-coordinator.ts
  - src/service/codex-command-coordinator.ts
  - src/service/rich-input-adapter.ts
  - src/interactions/normalize.ts
  - src/codex/notification-classifier.ts
  - src/service/turn-artifacts.ts
-->

# Codex App-Server Adoption

Verified against the current bridge implementation on 2026-03-30.

Use this file for the answer to:

- what the repository actually sends to `codex app-server` today
- which server requests the bridge adapts into Telegram UX
- which notifications are reduced into runtime cards, inspect data, or final-answer recovery
- where it is safe to extend the bridge without claiming protocol support that is not shipped

For protocol capability and full schema inventory, use `docs/research/`.
This file is only about the current bridge-owned adoption boundary.

## Current Boundary

The bridge runs one long-lived local `codex app-server` child over `stdio`.
The bridge owns process startup, health checks, timeout termination, restart, and request framing.

Current startup contract:

1. spawn `codex app-server --listen stdio://`
2. send `initialize`
3. send `initialized`
4. send `thread/list` as the readiness probe
5. only then mark the app-server connection ready

Timeout rule:

- normal RPCs use the bridge startup timeout
- history-heavy `thread/resume` and `thread/read` calls use a longer timeout
- timed-out requests terminate the child so the bridge can recover instead of leaving a half-dead process

## Request Families Used Today

### Session and thread lifecycle

Used directly by the current bridge:

- `initialize`
- `initialized`
- `thread/list`
- `thread/start`
- `thread/resume`
- `thread/read`
- `thread/archive`
- `thread/unarchive`
- `thread/fork`
- `thread/name/set`
- `thread/metadata/update`
- `thread/rollback`
- `thread/compact/start`
- `thread/backgroundTerminals/clean`

Primary owners:

- `src/codex/app-server.ts`
- `src/service/turn-coordinator.ts`
- `src/service/session-project-coordinator.ts`
- `src/service/codex-command-coordinator.ts`

### Turn execution and continuation

Used today:

- `turn/start`
- `turn/steer`
- `turn/interrupt`

Current bridge meaning:

- normal chat text and queued structured inputs become `turn/start`
- additional input during running or blocked turns uses `turn/steer`, with the active turn ID precondition and an acceptance acknowledgment
- interrupt is session-scoped Telegram control, not a raw transport diagnostic

Primary owners:

- `src/service/turn-coordinator.ts`
- `src/service/rich-input-adapter.ts`

### Control-plane discovery and command surfaces

Used today:

- `model/list`
- `config/read`
- `skills/list`
- `plugin/list`
- `plugin/install`
- `plugin/uninstall`
- `app/list`
- `mcpServerStatus/list`
- `config/mcpServer/reload`
- `mcpServer/oauth/login`
- `account/read`
- `account/rateLimits/read`
- `review/start`

Current bridge meaning:

- these methods are exposed only through compact Telegram command UX
- the bridge does not dump raw protocol payloads into chat
- session-level model selection is persisted bridge-side and applied on the next turn start
- `model/list` is used for candidate discovery; effective default model/effort truth comes from thread/runtime sources (`thread/start`, `thread/resume`, `config/read`)

Primary owner:

- `src/service/codex-command-coordinator.ts`

### Realtime voice fallback

Used today:

- `thread/realtime/start`
- `thread/realtime/appendAudio`
- `thread/realtime/stop`

Current bridge meaning:

- this is a narrow bridge-side transcription fallback for Telegram voice input
- the bridge does not ship a general realtime chat surface
- `thread/realtime/appendText` exists in the protocol wrapper but is not used by the current product

Primary owner:

- `src/service/rich-input-adapter.ts`

### Structured inputs sent today

Current `UserInput` variants surfaced by the bridge:

- `text`
- `localImage`
- `skill`
- `mention`

Important current product rules:

- Telegram photo uploads are downloaded bridge-side and re-sent as `localImage`
- remote URL `image` exists in the protocol wrapper but is not exposed as a direct Telegram command today
- queued structured inputs are attached to the next turn start when the user omits an inline prompt

## Server Requests The Bridge Adapts

Normalized and adapted into bridge-owned Telegram interactions today:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`
- legacy compatibility:
  - `applyPatchApproval`
  - `execCommandApproval`

Current handling split:

- `src/interactions/normalize.ts` converts raw server requests into a stable bridge interaction model
- `src/service/turn-coordinator.ts` rejects unsupported requests early or forwards supported ones to the interaction broker
- `src/service/interaction-broker.ts` owns persisted interaction cards and response lifecycle

Explicitly rejected today:

- `item/tool/call`
- `account/chatgptAuthTokens/refresh`

Those requests are protocol-visible but intentionally outside the current Telegram product boundary.
The bridge sends JSON-RPC `-32601` back to app-server and shows a compact Telegram notice instead of pretending support exists.

## Notification Families Reduced Today

The bridge does not mirror the raw notification stream into Telegram.
It classifies selected notifications and reduces them into runtime cards, inspect state, notices, and final-answer recovery.

Core lifecycle and thread state used today:

- `thread/started`
- `thread/name/updated`
- `thread/status/changed`
- `thread/tokenUsage/updated`
- `thread/compacted`
- `thread/archived`
- `thread/unarchived`
- `turn/started`
- `turn/completed`
- `turn/diff/updated`

Item and progress families used today:

- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `item/mcpToolCall/progress`
- `item/webSearch/progress`
- `item/commandExecution/terminalInteraction`

Operational or side-channel notifications used today:

- `serverRequest/resolved`
- `hook/started`
- `hook/completed`
- `configWarning`
- `deprecationNotice`
- `model/rerouted`
- `skills/changed`
- `error`
- compatibility events:
  - `codex/event/task_complete`
  - `codex/event/turn_aborted`

Primary reduction owners:

- `src/codex/notification-classifier.ts`
- `src/service/turn-coordinator.ts`
- `src/activity/tracker.ts`

## Final-Answer Recovery Contract

Current bridge order of truth:

1. live classified notifications for runtime progress
2. compatibility shortcut from `codex/event/task_complete` when it contains the final message
3. durable turn history from `thread/resume` or `thread/read`

History extraction rules today:

- prefer completed `agentMessage` items with `phase = final_answer`
- for review flows, allow review-exit and trailing non-commentary agent-message fallbacks
- do not treat `item/agentMessage/delta` as the authoritative stored answer

Primary owner:

- `src/service/turn-artifacts.ts`

## Not Shipped By This Bridge

These protocol-visible surfaces are still outside the current bridge boundary:

- filesystem RPCs under `fs/*`
- `plugin/read`
- remote skills APIs
- `collaborationMode/list` as a Telegram-facing selector
- `thread/realtime/appendText`
- realtime notification surfaces as a general chat product
- `command/exec*`
- `externalAgentConfig/*`
- `feedback/upload`
- `fuzzyFileSearch*`

Rule that matters:

- protocol presence is not product support
- if a feature is only visible in generated schema or research docs, do not describe it as current Telegram UX until bridge code and product docs both adopt it

## Safe Edit Boundaries

Safe local edits usually stay inside one of these slices:

- add or adjust a request wrapper in `src/codex/app-server.ts`
- add command-level adoption in `src/service/codex-command-coordinator.ts`
- add turn or lifecycle adoption in `src/service/turn-coordinator.ts`
- add structured-input wiring in `src/service/rich-input-adapter.ts`
- add notification classification in `src/codex/notification-classifier.ts`
- add interaction normalization in `src/interactions/normalize.ts`

Escalate or widen the read when:

- a new method needs both protocol lookup and Telegram UX design
- a server request requires a new persisted interaction-card shape
- a notification changes runtime-card semantics or final-answer truth rules
- a change would make current product docs claim support broader than the actual bridge behavior
