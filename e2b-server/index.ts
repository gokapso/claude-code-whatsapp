import { homedir } from "os";
import { join } from "path";
import {
  query,
  type Options,
  type SDKUserMessage,
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
      ...queryConfig,
      ...(queryConfig.anthropicApiKey && {
        env: {
          PATH: process.env.PATH,
          ANTHROPIC_API_KEY: queryConfig.anthropicApiKey,
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
