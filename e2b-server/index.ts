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

// Stored query configuration
let queryConfig: QueryConfig = {};

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
  try {
    const options: Options = {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project"],
      cwd: workspaceDirectory,
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
      ...((queryConfig.anthropicApiKey || queryConfig.githubToken) && {
        env: {
          PATH: process.env.PATH,
          ...(queryConfig.anthropicApiKey && {
            ANTHROPIC_API_KEY: queryConfig.anthropicApiKey,
          }),
          ...(queryConfig.githubToken && {
            GH_TOKEN: queryConfig.githubToken,
            GITHUB_TOKEN: queryConfig.githubToken,
          }),
        },
      }),
    };

    console.info("Starting query with options", options);

    activeStream = query({
      prompt: generateMessages(),
      options,
    });

    for await (const message of activeStream) {
      if (activeConnection) {
        const output: WSOutputMessage = {
          type: "sdk_message",
          data: message,
        };
        activeConnection.send(JSON.stringify(output));
      }
    }
  } catch (error) {
    console.error("Error processing messages:", error);
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
const server = Bun.serve({
  port: SERVER_PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // Configuration endpoint
    if (url.pathname === "/config" && req.method === "POST") {
      return req
        .json()
        .then((config) => {
          queryConfig = config as QueryConfig;
          return Response.json({ success: true, config: queryConfig });
        })
        .catch(() => {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        });
    }

    // Get current configuration
    if (url.pathname === "/config" && req.method === "GET") {
      return Response.json({ config: queryConfig });
    }

    // WebSocket endpoint
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      if (activeConnection) {
        const output: WSOutputMessage = {
          type: "error",
          error: "Server already has an active connection",
        };
        ws.send(JSON.stringify(output));
        ws.close();
        return;
      }

      activeConnection = ws;

      // Start processing messages when first connection is made
      if (!activeStream) {
        processMessages();
      }

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

console.log(`🚀 WebSocket server running on http://localhost:${server.port}`);
console.log(`   Config endpoint: http://localhost:${server.port}/config`);
console.log(`   WebSocket endpoint: ws://localhost:${server.port}/ws`);
