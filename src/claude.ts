import { ClaudeAgentClient } from "./lib/claude-agent/index.js";

type SessionData = {
  client: ClaudeAgentClient;
  sandboxId: string;
  branchName: string;
  githubRepo: string;
  isProcessing: boolean;
};

type PausedSession = {
  sandboxId: string;
  branchName: string;
  githubRepo: string;
};

// Active sessions (connected)
const activeSessions = new Map<string, SessionData>();

// Paused sessions (can be resumed)
const pausedSessions = new Map<string, PausedSession>();

export async function getOrCreateClient(
  contactId: string,
  githubRepo: string
): Promise<{
  client: ClaudeAgentClient;
  isNew: boolean;
  branchName?: string;
  githubRepo?: string;
  resumed?: boolean;
  sessionWasReset?: boolean;
}> {
  // Check active sessions
  if (activeSessions.has(contactId)) {
    const session = activeSessions.get(contactId)!;

    // If client disconnected (e.g., sandbox auto-paused), move to paused sessions
    if (!session.client.isConnected) {
      pausedSessions.set(contactId, {
        sandboxId: session.sandboxId,
        branchName: session.branchName,
        githubRepo: session.githubRepo,
      });
      activeSessions.delete(contactId);
      // Fall through to resume logic below
    } else {
      return {
        client: session.client,
        isNew: false,
        branchName: session.branchName,
        githubRepo: session.githubRepo,
      };
    }
  }

  // Check paused sessions - try to resume
  let sessionWasReset = false;
  if (pausedSessions.has(contactId)) {
    const paused = pausedSessions.get(contactId)!;
    try {
      const client = await ClaudeAgentClient.connect(paused.sandboxId, {
        e2bApiKey: process.env.E2B_API_KEY,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        githubToken: process.env.GITHUB_TOKEN,
        debug: true,
        tools: { type: "preset", preset: "claude_code" },
        systemPrompt: getSystemPrompt(paused.branchName, paused.githubRepo),
        sessionBranch: paused.branchName,
      });

      activeSessions.set(contactId, {
        client,
        sandboxId: paused.sandboxId,
        branchName: paused.branchName,
        githubRepo: paused.githubRepo,
        isProcessing: false,
      });
      pausedSessions.delete(contactId);

      return {
        client,
        isNew: false,
        branchName: paused.branchName,
        githubRepo: paused.githubRepo,
        resumed: true,
      };
    } catch {
      pausedSessions.delete(contactId);
      sessionWasReset = true; // Mark that we failed to resume
    }
  }

  // Generate branch name before creating client
  const branchName = generateBranchName(contactId);

  // Create new session
  const client = new ClaudeAgentClient({
    e2bApiKey: process.env.E2B_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    githubToken: process.env.GITHUB_TOKEN,
    template: process.env.E2B_TEMPLATE || "claude-whatsapp-server",
    timeoutMs: 30 * 60 * 1000, // 30 minutes inactivity timeout
    autoPause: true, // Pause on timeout instead of kill
    debug: true,
    tools: { type: "preset", preset: "claude_code" },
    systemPrompt: getSystemPrompt(branchName, githubRepo),
    sessionBranch: branchName,
  });

  await client.start();

  activeSessions.set(contactId, {
    client,
    sandboxId: client.sandboxId || "",
    githubRepo,
    branchName,
    isProcessing: false,
  });

  return { client, isNew: true, branchName, githubRepo, sessionWasReset };
}

function generateBranchName(contactId: string): string {
  const timestamp = Date.now().toString(36);
  const sanitizedContact = contactId.replace(/[^a-zA-Z0-9]/g, "").slice(-6);
  return `session/${sanitizedContact}-${timestamp}`;
}

function getSystemPrompt(branchName: string, githubRepo: string) {
  return {
    type: "preset" as const,
    preset: "claude_code" as const,
    append: `\n\nYou are helping a user via WhatsApp. Keep responses concise but helpful.
The GitHub repository ${githubRepo} should be cloned to /home/user/workspace.
Always work within this directory.
You are working on branch: ${branchName}. Do not switch or create other branches.

When creating PRs or commits, always end the description/body with:
🤖 Generated with [Claude Code](https://claude.ai/code) on WhatsApp using [Kapso](https://kapso.ai)`,
  };
}

export async function setupRepository(
  client: ClaudeAgentClient,
  branchName: string,
  githubRepo: string
): Promise<void> {
  const githubToken = process.env.GITHUB_TOKEN;

  const cloneUrl = githubToken
    ? `https://${githubToken}@github.com/${githubRepo}.git`
    : `https://github.com/${githubRepo}.git`;

  // Clone repo directly using shell commands (not via Claude)
  const cloneResult = await client.runCommand(
    `git clone ${cloneUrl} /home/user/workspace`
  );

  if (cloneResult.exitCode !== 0) {
    throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
  }

  // Configure git identity for commits
  await client.runCommand(
    `cd /home/user/workspace && git config user.name "Claude on Kapso" && git config user.email "claude@kap.so"`
  );

  // Create and checkout new branch
  const branchResult = await client.runCommand(
    `cd /home/user/workspace && git checkout -b ${branchName}`
  );

  if (branchResult.exitCode !== 0) {
    throw new Error(`Failed to create branch: ${branchResult.stderr}`);
  }
}

type ToolUseInfo = {
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
};

/** Interrupt an active session if it's currently processing */
export function interruptSession(contactId: string): boolean {
  const session = activeSessions.get(contactId);
  if (!session || !session.isProcessing) {
    return false;
  }
  session.client.interrupt();
  return true;
}

/** Check if a session is currently processing a message */
export function isSessionProcessing(contactId: string): boolean {
  const session = activeSessions.get(contactId);
  return session?.isProcessing ?? false;
}

export async function sendMessage(
  client: ClaudeAgentClient,
  contactId: string,
  message: string,
  onMessage: (text: string) => void,
  onToolComplete?: (tool: ToolUseInfo) => void
): Promise<void> {
  // Mark session as processing
  const session = activeSessions.get(contactId);
  if (session) {
    session.isProcessing = true;
  }

  // Track pending tool calls to match with results
  const pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>();

  return new Promise((resolve, reject) => {
    let resolved = false;

    const cleanup = () => {
      if (session) {
        session.isProcessing = false;
      }
    };

    const unsubscribe = client.onMessage((msg) => {
      if (resolved) return;

      if (msg.type === "sdk_message") {
        const data = msg.data as {
          type: string;
          subtype?: string;
          tool_use_id?: string;
          content?: string | Array<{ type: string; text?: string }>;
          message?: {
            role?: string;
            content: Array<{
              type?: string;
              text?: string;
              name?: string;
              input?: Record<string, unknown>;
              id?: string; // tool_use blocks use "id"
              tool_use_id?: string; // tool_result blocks use "tool_use_id"
              content?: string;
              is_error?: boolean;
            }>;
          };
        };

        if (data.type === "assistant" && data.message?.content) {
          for (const block of data.message.content) {
            if (block.text) {
              onMessage(block.text);
            } else if (block.type === "tool_use" && block.name && block.id) {
              // Store pending tool call
              pendingTools.set(block.id, {
                name: block.name,
                input: block.input || {},
              });
            }
          }
        } else if (data.type === "user" && data.message?.content && onToolComplete) {
          // Handle tool results
          for (const block of data.message.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              const pendingTool = pendingTools.get(block.tool_use_id);
              if (pendingTool) {
                pendingTools.delete(block.tool_use_id);
                onToolComplete({
                  name: pendingTool.name,
                  input: pendingTool.input,
                  result: typeof block.content === "string" ? block.content : "",
                  isError: block.is_error,
                });
              }
            }
          }
        } else if (data.type === "result") {
          resolved = true;
          unsubscribe();
          cleanup();
          resolve();
        }
      } else if (msg.type === "error") {
        resolved = true;
        unsubscribe();
        cleanup();
        reject(new Error(msg.error));
      }
    });

    client.send({
      type: "user_message",
      data: {
        type: "user",
        session_id: contactId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: message,
        },
      },
    });

    // Timeout after 10 minutes
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsubscribe();
        cleanup();
        reject(new Error("Request timed out"));
      }
    }, 600000);
  });
}

export async function pauseClient(contactId: string): Promise<void> {
  const session = activeSessions.get(contactId);
  if (!session) return;

  try {
    await session.client.pause();
    pausedSessions.set(contactId, {
      sandboxId: session.sandboxId,
      branchName: session.branchName,
      githubRepo: session.githubRepo,
    });
  } catch {
    // Ignore pause errors
  }

  activeSessions.delete(contactId);
}

export async function killClient(contactId: string): Promise<void> {
  const session = activeSessions.get(contactId);
  if (session) {
    await session.client.stop();
    activeSessions.delete(contactId);
  }

  // Also remove from paused sessions
  pausedSessions.delete(contactId);
}

export function hasActiveClient(contactId: string): boolean {
  return activeSessions.has(contactId);
}

export function hasPausedSession(contactId: string): boolean {
  return pausedSessions.has(contactId);
}

export function getSessionStats(): {
  active: number;
  paused: number;
} {
  return {
    active: activeSessions.size,
    paused: pausedSessions.size,
  };
}

export function getSessionInfo(contactId: string): {
  sandboxId: string;
  branchName: string;
  githubRepo: string;
  status: "active" | "paused";
} | null {
  const active = activeSessions.get(contactId);
  if (active) {
    return {
      sandboxId: active.sandboxId,
      branchName: active.branchName,
      githubRepo: active.githubRepo,
      status: "active",
    };
  }
  const paused = pausedSessions.get(contactId);
  if (paused) {
    return {
      sandboxId: paused.sandboxId,
      branchName: paused.branchName,
      githubRepo: paused.githubRepo,
      status: "paused",
    };
  }
  return null;
}
