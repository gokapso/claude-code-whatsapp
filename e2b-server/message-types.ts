import {
  type AgentDefinition,
  type McpHttpServerConfig,
  type McpSSEServerConfig,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// WebSocket message types
export type WSInputMessage =
  | {
      type: "user_message";
      data: SDKUserMessage;
    }
  | { type: "interrupt" };

export type WSOutputMessage =
  | { type: "connected" }
  | { type: "sdk_message"; data: SDKMessage }
  | { type: "error"; error: string }
  | { type: "info"; data: string };

export type McpRemoteServerConfig = McpHttpServerConfig | McpSSEServerConfig;

// Configuration type for the query options
export type QueryConfig = {
  agents?: Record<string, AgentDefinition>;
  allowedTools?: string[];
  systemPrompt?:
    | string
    | {
        type: "preset";
        preset: "claude_code";
        append?: string;
      };
  model?: string;
  mcpServers?: Record<string, McpRemoteServerConfig>;
  anthropicApiKey?: string;
};
