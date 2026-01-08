import { homedir } from "os";
import { join } from "path";
import {
  query,
  type Options,
  type SDKUserMessage,
  type PreToolUseHookInput,
  type HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { type ServerWebSocket } from "bun";

import { SERVER_PORT, WORKSPACE_DIR_NAME } from "./const";
import { handleMessage } from "./message-handler";
import { type QueryConfig, type WSOutputMessage } from "./message-types";

const workspaceDirectory = join(homedir(), WORKSPACE_DIR_NAME);

// Single WebSocket connection (only one allowed)
let activeConnection: ServerWebSocket | null = null;

// Message queue
const messageQueue: SDKUserMessage[] = [];

// Stream reference for interrupts
let activeStream: ReturnType<typeof query> | null = null;

// AbortController for cancelling the current query
let queryAbortController: AbortController | null = null;

// Stored query configuration
let queryConfig: QueryConfig = {};

// Server instance (mutable for restart)
let server: ReturnType<typeof Bun.serve> | null = null;

// Create an async generator that yields messages from the queue
async function* generateMessages() {
  while (true) {
    // Wait for messages in the queue
    while (messageQueue.length > 0) {
      const message = messageQueue.shift();
      yield message!;
    }

    // Small delay to prevent tight loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Check if a command tries to change/create/delete branches
function isGitBranchOperation(command: string): boolean {
  // Block: git checkout <branch>, git checkout -b, git switch, git branch -d/-D/create
  // Allow: git checkout -- <file> (restore file)
  const patterns = [
    /\bgit\s+checkout\s+(?!--\s)/, // git checkout <anything> except -- (file restore)
    /\bgit\s+switch\b/, // any git switch
    /\bgit\s+branch\s+(-[dDmM]|[^-])/, // git branch -d/-D/-m/-M or git branch <name>
  ];
  return patterns.some((p) => p.test(command));
}

// PreToolUse hook to block git branch operations
async function branchProtectionHook(
  input: PreToolUseHookInput,
  _toolUseId: string | undefined,
  _options: { signal: AbortSignal }
): Promise<HookJSONOutput> {
  const toolInput = input.tool_input as { command?: string };
  const command = toolInput.command || "";

  if (isGitBranchOperation(command)) {
    const branch = queryConfig.sessionBranch || "session branch";
    return {
      continue: false,
      reason: `Branch operations are disabled. Work on ${branch} only.`,
    };
  }

  return { continue: true };
}

// Process messages from the SDK and send to WebSocket client
async function processMessages() {
  // Create new AbortController for this session
  queryAbortController = new AbortController();
  const currentController = queryAbortController;

  try {
    const options: Options = {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project"],
      cwd: workspaceDirectory,
      abortController: currentController,
      stderr: (data) => {
        if (activeConnection) {
          const output: WSOutputMessage = {
            type: "info",
            data,
          };
          activeConnection.send(JSON.stringify(output));
        }
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [branchProtectionHook],
          },
        ],
      },
      ...queryConfig,
      // Spread sandbox env vars and add our tokens on top
      env: {
        ...process.env,
        ...(queryConfig.anthropicApiKey && {
          ANTHROPIC_API_KEY: queryConfig.anthropicApiKey,
        }),
        ...(queryConfig.githubToken && {
          GH_TOKEN: queryConfig.githubToken,
          GITHUB_TOKEN: queryConfig.githubToken,
        }),
      },
    };


    activeStream = query({
      prompt: generateMessages(),
      options,
    });

    for await (const message of activeStream) {
      if (currentController.signal.aborted) {
        break;
      }
      if (activeConnection) {
        const output: WSOutputMessage = {
          type: "sdk_message",
          data: message,
        };
        activeConnection.send(JSON.stringify(output));
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return;
    }
    if (activeConnection) {
      const output: WSOutputMessage = {
        type: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      };
      activeConnection.send(JSON.stringify(output));
    }
  }
}

// Create WebSocket server
server = Bun.serve({
  hostname: "0.0.0.0",  // Bind to all interfaces (required for E2B)
  port: SERVER_PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // Configuration endpoint
    if (url.pathname === "/config" && req.method === "POST") {
      return req
        .json()
        .then((config) => {
          queryConfig = config as QueryConfig;
          return Response.json({ success: true });
        })
        .catch(() => {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        });
    }

    // Get current configuration
    if (url.pathname === "/config" && req.method === "GET") {
      return Response.json({ config: queryConfig });
    }

    // Restart endpoint - resets server state after pause/resume
    if (url.pathname === "/restart" && req.method === "POST") {
      if (queryAbortController) {
        queryAbortController.abort();
        queryAbortController = null;
      }
      if (activeConnection) {
        try { activeConnection.close(); } catch {}
        activeConnection = null;
      }
      activeStream = null;
      messageQueue.length = 0;
      return Response.json({ success: true });
    }

    // WebSocket endpoint
    if (url.pathname === "/ws") {
      if (server!.upgrade(req)) return;
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    // Disable idle timeout - after pause/resume, time jumps can trigger it immediately
    idleTimeout: 0,

    open(ws) {
      if (queryAbortController) {
        queryAbortController.abort();
        queryAbortController = null;
      }
      if (activeConnection) {
        try { activeConnection.close(); } catch {}
      }
      activeConnection = ws;
      activeStream = null;
      messageQueue.length = 0;

      processMessages();

      const output: WSOutputMessage = { type: "connected" };
      ws.send(JSON.stringify(output));
    },

    async message(ws, message) {
      await handleMessage(ws, message, {
        messageQueue,
        getActiveStream: () => activeStream,
      });
    },

    close(ws) {
      if (activeConnection === ws) {
        activeConnection = null;
      }
    },
  },
});

console.log(`Server running on port ${server.port}`);
