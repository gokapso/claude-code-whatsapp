/**
 * Type definitions for Claude Agent Client
 * Based on @dzhng/claude-agent
 */

import type {
  AgentDefinition,
  McpHttpServerConfig,
  McpSSEServerConfig,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// Re-export e2b types
export {
  FilesystemEventType,
  type FilesystemEvent,
  type WatchHandle,
} from "e2b";

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
  tools?: string[] | { type: "preset"; preset: "claude_code" };
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
  /** GitHub token for gh CLI (PR creation, etc.) */
  githubToken?: string;
  /** Session branch name - used to block git branch operations */
  sessionBranch?: string;
};

/**
 * Configuration options for the Claude Agent Client
 */
export interface ClientOptions extends Partial<QueryConfig> {
  /** E2B API key */
  e2bApiKey?: string;
  /** E2B template name. Defaults to 'claude-whatsapp-server' */
  template?: string;
  /** Timeout in milliseconds. Defaults to 30 minutes */
  timeoutMs?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Auto-pause sandbox on timeout instead of killing. Defaults to true */
  autoPause?: boolean;
}
