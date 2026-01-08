import { ClaudeAgentClient } from "@dzhng/claude-agent";

// Store active clients per WhatsApp contact
const activeClients = new Map<string, ClaudeAgentClient>();

export async function getOrCreateClient(
  contactId: string
): Promise<{ client: ClaudeAgentClient; isNew: boolean }> {
  if (activeClients.has(contactId)) {
    return { client: activeClients.get(contactId)!, isNew: false };
  }

  const githubRepo = process.env.GITHUB_REPO!;

  const client = new ClaudeAgentClient({
    e2bApiKey: process.env.E2B_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    template: process.env.E2B_TEMPLATE || "claude-whatsapp-server",
    timeoutMs: 60 * 60 * 1000, // 1 hour
    debug: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: `\n\nYou are helping a user via WhatsApp. Keep responses concise but helpful.
The GitHub repository ${githubRepo} should be cloned to /home/user/workspace.
Always work within this directory.`,
    },
  });

  await client.start();
  activeClients.set(contactId, client);

  return { client, isNew: true };
}

export async function setupRepository(client: ClaudeAgentClient): Promise<void> {
  const githubRepo = process.env.GITHUB_REPO!;
  const githubToken = process.env.GITHUB_TOKEN;

  const cloneUrl = githubToken
    ? `https://${githubToken}@github.com/${githubRepo}.git`
    : `https://github.com/${githubRepo}.git`;

  // Send a message to Claude to clone the repo
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
          content: `Clone the repository ${cloneUrl} to /home/user/workspace. Just run the git clone command, no explanation needed.`,
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

export async function sendMessage(
  client: ClaudeAgentClient,
  sessionId: string,
  message: string,
  onMessage: (text: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const unsubscribe = client.onMessage((msg) => {
      if (resolved) return;

      if (msg.type === "sdk_message") {
        const data = msg.data as {
          type: string;
          message?: { content: Array<{ text?: string }> };
        };

        if (data.type === "assistant" && data.message?.content) {
          for (const block of data.message.content) {
            if (block.text) {
              onMessage(block.text);
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

    // Timeout after 10 minutes (Claude Code operations can be long)
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsubscribe();
        reject(new Error("Request timed out"));
      }
    }, 600000);
  });
}

export async function killClient(contactId: string): Promise<void> {
  const client = activeClients.get(contactId);
  if (client) {
    await client.stop();
    activeClients.delete(contactId);
  }
}

export function hasActiveClient(contactId: string): boolean {
  return activeClients.has(contactId);
}
