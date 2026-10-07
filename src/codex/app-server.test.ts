import test from "node:test";
import assert from "node:assert/strict";

import type { Logger } from "../logger.js";
import { TELEGRAM_PACK } from "../packs/telegram/index.js";
import { CodexAppServerClient, buildThreadStartParams, buildTurnStartParams } from "./app-server.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

test("buildThreadStartParams requests full-access sandbox", () => {
  assert.deepEqual(buildThreadStartParams({
    cwd: "/tmp/project",
    dynamicTools: TELEGRAM_PACK.platformActions.getDynamicToolDeclarations()
  }), {
    cwd: "/tmp/project",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    dynamicTools: [{
      name: "send_telegram_document",
      description: "Send a local server file to the active control surface as a document attachment.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          caption: { type: "string" },
          filename: { type: "string" }
        },
        required: ["path"]
      }
    }, {
      name: "send_telegram_image",
      description: "Send a local server image to the active control surface.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          caption: { type: "string" }
        },
        required: ["path"]
      }
    }]
  });
});

test("buildThreadStartParams can mark a clear-start replacement thread", () => {
  assert.deepEqual(buildThreadStartParams({
    cwd: "/tmp/project",
    sessionStartSource: "clear"
  }), {
    cwd: "/tmp/project",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    dynamicTools: [],
    sessionStartSource: "clear"
  });
});

test("buildTurnStartParams uses turn-level sandbox overrides", () => {
  assert.deepEqual(
    buildTurnStartParams({
      threadId: "thread-1",
      cwd: "/tmp/project",
      text: "edit files"
    }),
    {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "edit files" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    }
  );
});

test("buildTurnStartParams includes collaboration mode when requested", () => {
  assert.deepEqual(
    buildTurnStartParams({
      threadId: "thread-1",
      cwd: "/tmp/project",
      text: "plan the work",
      model: "gpt-5",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5",
          developerInstructions: null,
          reasoningEffort: "medium"
        }
      }
    } as any),
    {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "plan the work" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: "gpt-5",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5",
          developer_instructions: null,
          reasoning_effort: "medium"
        }
      }
    }
  );
});

test("buildTurnStartParams supports explicit default collaboration mode", () => {
  assert.deepEqual(
    buildTurnStartParams({
      threadId: "thread-1",
      cwd: "/tmp/project",
      text: "implement the work",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5",
          developerInstructions: null,
          reasoningEffort: null
        }
      }
    }),
    {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "implement the work" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5",
          developer_instructions: null,
          reasoning_effort: null
        }
      }
    }
  );
});

test("listThreads sends archived filters through the JSON-RPC client", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  let captured: { method: string; params: unknown } | null = null;

  (client as any).request = async (method: string, params: unknown) => {
    captured = { method, params };
    return { data: [], nextCursor: null };
  };

  await client.listThreads({
    archived: true,
    limit: 20,
    sortKey: "updated_at"
  });

  assert.deepEqual(captured, {
    method: "thread/list",
    params: {
      archived: true,
      limit: 20,
      sortKey: "updated_at"
    }
  });
});

test("readThread sends includeTurns when requested", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  let captured: { method: string; params: unknown; options: unknown } | null = null;

  (client as any).request = async (method: string, params: unknown, options: unknown) => {
    captured = { method, params, options };
    return { thread: { id: "thread-1", turns: [] } };
  };

  await client.readThread("thread-1", true, {
    timeoutMs: 321,
    terminateOnTimeout: false
  });

  assert.deepEqual(captured, {
    method: "thread/read",
    params: {
      threadId: "thread-1",
      includeTurns: true
    },
    options: {
      timeoutMs: 321,
      terminateOnTimeout: false
    }
  });
});

test("readConfig sends cwd and includeLayers when requested", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  let captured: { method: string; params: unknown } | null = null;

  (client as any).request = async (method: string, params: unknown) => {
    captured = { method, params };
    return { config: {}, origins: {} };
  };

  await client.readConfig({
    cwd: "/tmp/project",
    includeLayers: true
  });

  assert.deepEqual(captured, {
    method: "config/read",
    params: {
      cwd: "/tmp/project",
      includeLayers: true
    }
  });
});

test("handleMessage routes method-plus-id frames to server request handlers", () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  const requests: unknown[] = [];

  client.onServerRequest((request) => {
    requests.push(request);
  });

  (client as any).handleMessage(JSON.stringify({
    id: "server-1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: []
    }
  }));

  assert.deepEqual(requests, [{
    id: "server-1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: []
    }
  }]);
});

test("handleMessage keeps response resolution intact alongside server requests", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  let resolved: unknown = null;
  let rejected: unknown = null;
  const timer = setTimeout(() => {}, 10_000);

  (client as any).pending.set(7, {
    resolve: (value: unknown) => {
      resolved = value;
    },
    reject: (error: unknown) => {
      rejected = error;
    },
    timer
  });

  (client as any).handleMessage(JSON.stringify({
    id: 7,
    result: {
      ok: true
    }
  }));

  clearTimeout(timer);
  assert.deepEqual(resolved, { ok: true });
  assert.equal(rejected, null);
});

test("respondToServerRequest writes a JSON-RPC result frame", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  const writes: string[] = [];

  (client as any).child = {
    stdin: {
      write: (chunk: string, _encoding: string, callback?: (error?: Error | null) => void) => {
        writes.push(chunk);
        callback?.(null);
      }
    }
  };

  await client.respondToServerRequest("server-2", { decision: "accept" });

  assert.deepEqual(writes, [
    `${JSON.stringify({
      id: "server-2",
      result: { decision: "accept" }
    })}\n`
  ]);
});

test("steerTurn sends expectedTurnId and structured input without terminating on timeout", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  let captured: { method: string; params: unknown } | null = null;
  let requestOptions: unknown;

  (client as any).request = async (method: string, params: unknown, options: unknown) => {
    captured = { method, params };
    requestOptions = options;
    return {};
  };

  await client.steerTurn({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "continue" }]
  });

  assert.deepEqual(captured, {
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "continue" }]
    }
  });
  assert.deepEqual(requestOptions, { terminateOnTimeout: false });
});

test("app-server preserves RPC rejection codes for safe steering fallback", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  (client as any).child = {
    stdin: { write: (line: string, _encoding: string, callback: (error: null) => void) => {
      callback(null);
      (client as any).handleMessage(JSON.stringify({ id: JSON.parse(line).id, error: { code: -32600, message: "no active turn to steer" } }));
    } }
  };
  await assert.rejects(client.steerTurn({ threadId: "thread-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "context" }] }), {
    name: "AppServerRpcError", code: -32600, message: "no active turn to steer"
  });
});

test("phase6 plugin and app requests send the current schema-backed params", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  const captured: Array<{ method: string; params: unknown }> = [];

  (client as any).request = async (method: string, params: unknown) => {
    captured.push({ method, params });
    if (method === "plugin/list") {
      return { marketplaces: [] };
    }
    if (method === "plugin/install") {
      return { appsNeedingAuth: [] };
    }
    if (method === "app/list") {
      return { data: [], nextCursor: null };
    }
    return {};
  };

  await client.listPlugins({ cwds: ["/tmp/project-one"] });
  await client.installPlugin({
    marketplacePath: "/marketplaces/repo",
    pluginName: "deploy"
  });
  await client.listApps({
    threadId: "thread-1",
    forceRefetch: true,
    limit: 10
  });

  assert.deepEqual(captured, [
    {
      method: "plugin/list",
      params: {
        cwds: ["/tmp/project-one"]
      }
    },
    {
      method: "plugin/install",
      params: {
        marketplacePath: "/marketplaces/repo",
        pluginName: "deploy"
      }
    },
    {
      method: "app/list",
      params: {
        threadId: "thread-1",
        forceRefetch: true,
        limit: 10
      }
    }
  ]);
});

test("phase6 mcp account and background-terminal requests use the expected methods", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  const captured: Array<{ method: string; params: unknown }> = [];

  (client as any).request = async (method: string, params: unknown) => {
    captured.push({ method, params });
    if (method === "mcpServerStatus/list") {
      return { data: [], nextCursor: null };
    }
    if (method === "mcpServer/oauth/login") {
      return { authorizationUrl: "https://auth.example/mcp" };
    }
    if (method === "account/read") {
      return {
        account: { type: "chatgpt", email: "me@example.com", planType: "plus" },
        requiresOpenaiAuth: false
      };
    }
    if (method === "account/rateLimits/read") {
      return {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: null,
          secondary: null,
          credits: null,
          planType: "plus"
        },
        rateLimitsByLimitId: null
      };
    }
    return {};
  };

  await client.listMcpServerStatuses({ limit: 20 });
  await client.reloadMcpServers();
  await client.loginToMcpServer({ name: "github" });
  await client.readAccount(false);
  await client.readAccountRateLimits();
  await client.cleanBackgroundTerminals("thread-1");

  assert.deepEqual(captured, [
    {
      method: "mcpServerStatus/list",
      params: {
        limit: 20
      }
    },
    {
      method: "config/mcpServer/reload",
      params: undefined
    },
    {
      method: "mcpServer/oauth/login",
      params: {
        name: "github"
      }
    },
    {
      method: "account/read",
      params: {
        refreshToken: false
      }
    },
    {
      method: "account/rateLimits/read",
      params: undefined
    },
    {
      method: "thread/backgroundTerminals/clean",
      params: {
        threadId: "thread-1"
      }
    }
  ]);
});

test("CodexAppServerClient terminates the child when a request times out", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server-timeout.log", testLogger, 5);
  const killSignals: string[] = [];

  (client as any).child = {
    pid: 123,
    stdin: {
      write: (_payload: string, _encoding: string, callback?: (error?: Error | null) => void) => {
        setImmediate(() => callback?.(null));
      }
    },
    kill: (signal: string) => {
      killSignals.push(signal);
      return true;
    }
  };

  await assert.rejects(
    client.request("thread/resume", { threadId: "thread-timeout" }, { timeoutMs: 5 }),
    /app-server request timed out: thread\/resume/u
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(killSignals, ["SIGTERM"]);
  assert.equal(client.isRunning, false);
});

test("request records app-server RPC perf events", async () => {
  const operations: unknown[] = [];
  const client = new CodexAppServerClient(
    "codex",
    "/tmp/app-server.log",
    testLogger,
    5000,
    {
      performanceRecorder: {
        recordOperation: async (event: unknown) => {
          operations.push(event);
        }
      }
    } as any
  );

  (client as any).child = {
    stdin: {
      write: (chunk: string, _encoding: string, callback?: (error?: Error | null) => void) => {
        callback?.(null);
        const payload = JSON.parse(chunk);
        queueMicrotask(() => {
          (client as any).handleMessage(JSON.stringify({
            id: payload.id,
            result: { ok: true }
          }));
        });
      }
    }
  };

  const result = await client.request("thread/list", {});

  assert.deepEqual(result, { ok: true });
  assert.equal(operations.length, 1);
  assert.match(JSON.stringify(operations[0]), /"category":"app_server_rpc"/u);
  assert.match(JSON.stringify(operations[0]), /"name":"thread\/list"/u);
  assert.match(JSON.stringify(operations[0]), /"outcome":"ok"/u);
});
