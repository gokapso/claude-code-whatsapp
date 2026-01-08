import { ClaudeAgentClient } from "./lib/claude-agent/index.js";

type SessionData = {
  client: ClaudeAgentClient;
  sandboxId: string;
  branchName: string;
  githubRepo: string;
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
}> {
  // Check active sessions
  if (activeSessions.has(contactId)) {
    const session = activeSessions.get(contactId)!;
    return {
      client: session.client,
      isNew: false,
      branchName: session.branchName,
      githubRepo: session.githubRepo,
    };
  }

  // Check paused sessions - try to resume
  if (pausedSessions.has(contactId)) {
    const paused = pausedSessions.get(contactId)!;
    try {
      console.log(`🔄 Resuming sandbox ${paused.sandboxId}...`);
      const client = await ClaudeAgentClient.connect(paused.sandboxId, {
        e2bApiKey: process.env.E2B_API_KEY,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
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
      });
      pausedSessions.delete(contactId);

      return {
        client,
        isNew: false,
        branchName: paused.branchName,
        githubRepo: paused.githubRepo,
        resumed: true,
      };
    } catch (e) {
      console.log(
        `Failed to resume sandbox ${paused.sandboxId}:`,
        e instanceof Error ? e.message : e
      );
      pausedSessions.delete(contactId);
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
    timeoutMs: 5 * 60 * 1000, // 5 minutes inactivity timeout
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
  });

  return { client, isNew: true, branchName, githubRepo };
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
You are working on branch: ${branchName}. Do not switch or create other branches.`,
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

  // Send a message to Claude to clone the repo and create branch
  return new Promise((resolve, reject) => {
    let resolved = false;

    const unsubscribe = client.onMessage((msg) => {
      if (resolved) return;

      if (msg.type === "sdk_message") {
        const data = msg.data as { type: string };
        if (data.type === "result") {
          resolved = true;
          unsubscribe();
          resolve();
        }
      } else if (msg.type === "error") {
        resolved = true;
        unsubscribe();
        reject(new Error(msg.error));
      }
    });

    client.send({
      type: "user_message",
      data: {
        type: "user",
        session_id: "setup",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: `Clone the repository ${cloneUrl} to /home/user/workspace, then create and checkout a new branch called "${branchName}". Just run the commands, no explanation needed.`,
        },
      },
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsubscribe();
        reject(new Error("Repository clone timed out"));
      }
    }, 120000);
  });
}

type ToolUseInfo = {
  name: string;
  description?: string;
  input?: Record<string, unknown>;
};

export async function sendMessage(
  client: ClaudeAgentClient,
  sessionId: string,
  message: string,
  onMessage: (text: string) => void,
  onToolUse?: (tool: ToolUseInfo) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const unsubscribe = client.onMessage((msg) => {
      if (resolved) return;

      if (msg.type === "sdk_message") {
        const data = msg.data as {
          type: string;
          message?: {
            content: Array<{
              type?: string;
              text?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
          };
        };

        if (data.type === "assistant" && data.message?.content) {
          for (const block of data.message.content) {
            if (block.text) {
              onMessage(block.text);
            } else if (block.type === "tool_use" && block.name && onToolUse) {
              const input = block.input || {};
              const description =
                (input.description as string) ||
                (input.command as string) ||
                (input.file_path as string);
              onToolUse({ name: block.name, description, input });
            }
          }
        } else if (data.type === "result") {
          resolved = true;
          unsubscribe();
          resolve();
        }
      } else if (msg.type === "error") {
        resolved = true;
        unsubscribe();
        reject(new Error(msg.error));
      }
    });

    client.send({
      type: "user_message",
      data: {
        type: "user",
        session_id: sessionId,
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
        reject(new Error("Request timed out"));
      }
    }, 600000);
  });
}

export async function pauseClient(contactId: string): Promise<void> {
  const session = activeSessions.get(contactId);
  if (!session) return;

  console.log(`⏸️ Pausing session for ${contactId}...`);

  try {
    await session.client.pause();
    pausedSessions.set(contactId, {
      sandboxId: session.sandboxId,
      branchName: session.branchName,
      githubRepo: session.githubRepo,
    });
  } catch (e) {
    console.error(`Failed to pause session:`, e);
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
