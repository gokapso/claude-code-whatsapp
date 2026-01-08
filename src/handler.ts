import {
  sendWhatsAppMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  markAsReadWithTyping,
  type ParsedMessage,
} from "./kapso.js";
import {
  getOrCreateClient,
  setupRepository,
  sendMessage,
  killClient,
  getSessionInfo,
  hasActiveClient,
  hasPausedSession,
  interruptSession,
} from "./claude.js";
import { fetchAccessibleRepos, type GitHubRepo } from "./github.js";
import { MessageBuffer } from "./formatter.js";

type ToolInput = {
  file_path?: string;
  command?: string;
  pattern?: string;
  path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
};

type ToolInfo = {
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
};

function truncate(str: string, maxLines: number, maxChars: number): string {
  const lines = str.split("\n").slice(0, maxLines);
  const result = lines.join("\n");
  return result.length > maxChars ? result.slice(0, maxChars) + "..." : result;
}

function formatToolMessage(tool: ToolInfo): string {
  const input = (tool.input || {}) as ToolInput;
  const result = tool.result ? truncate(tool.result, 8, 400) : "";
  const divider = "──────────";

  switch (tool.name) {
    case "Edit": {
      const file = input.file_path?.split("/").pop() || "file";
      const oldCode = input.old_string
        ? "```\n- " + truncate(input.old_string, 6, 200).split("\n").join("\n- ") + "\n```"
        : "";
      const newCode = input.new_string
        ? "```\n+ " + truncate(input.new_string, 6, 200).split("\n").join("\n+ ") + "\n```"
        : "";
      return `📝 Edit \`${file}\`\n${divider}\n${oldCode}\n${newCode}`;
    }

    case "Write": {
      const file = input.file_path?.split("/").pop() || "file";
      return `📝 Write \`${file}\`${result ? `\n${divider}\n${result}` : ""}`;
    }

    case "Read": {
      const file = input.file_path?.split("/").pop() || "file";
      // Don't show result for Read (too long)
      return `📖 Read \`${file}\``;
    }

    case "Bash": {
      const cmd = input.command ? truncate(input.command, 1, 60) : "";
      const output = result ? `\n${divider}\n\`\`\`\n${result}\n\`\`\`` : "";
      return `⚡ Bash \`${cmd}\`${output}`;
    }

    case "Glob":
    case "Grep": {
      const pattern = input.pattern || "";
      const path = input.path ? ` in \`${input.path}\`` : "";
      return `🔍 ${tool.name} \`${pattern}\`${path}${result ? `\n${divider}\n${result}` : ""}`;
    }

    default: {
      return `🔧 ${tool.name}${result ? `\n${divider}\n${result}` : ""}`;
    }
  }
}

const BUTTON_CONTINUE = "continue_session";
const BUTTON_RESET = "reset_session";
const REPO_PREFIX = "repo:";

// Pending repo selections (user selected repo but hasn't sent task yet)
const pendingRepos = new Map<string, string>();

// Sessions currently being set up (prevents race conditions)
const settingUpSessions = new Set<string>();

function isRepoSelection(buttonId: string | undefined): boolean {
  return buttonId?.startsWith(REPO_PREFIX) || false;
}

function getRepoFromButtonId(buttonId: string): string {
  return buttonId.slice(REPO_PREFIX.length);
}

const WELCOME_BODY = `Work with Claude directly in your codebase. Build, debug, and ship from WhatsApp.

*Commands*
Claude: \`/compact\` \`/clear\` \`/status\` \`/help\`
Custom: \`/info\` \`/reset\``;

async function showWelcomeWithRepos(to: string, repos: GitHubRepo[]): Promise<void> {
  if (repos.length === 0) {
    await sendWhatsAppMessage(
      to,
      "No repositories found. Make sure your GitHub token has access to at least one repository."
    );
    return;
  }

  if (repos.length === 1) {
    // Show welcome with repo info and Start button
    await sendInteractiveButtons(to, {
      header: "Claude Code 🤖",
      body: `${WELCOME_BODY}\n\n📁 ${repos[0].fullName}`,
      footer: "Powered by Kapso",
      buttons: [{ id: `${REPO_PREFIX}${repos[0].fullName}`, title: "Start" }],
    });
    return;
  }

  if (repos.length <= 3) {
    // Show as buttons (max 3)
    await sendInteractiveButtons(to, {
      header: "Claude Code 🤖",
      body: WELCOME_BODY,
      footer: "Powered by Kapso",
      buttons: repos.map((repo) => ({
        id: `${REPO_PREFIX}${repo.fullName}`,
        title: repo.name.slice(0, 20), // Button title max 20 chars
      })),
    });
    return;
  }

  // Show as list (more than 3)
  await sendInteractiveList(to, {
    header: "Claude Code 🤖",
    body: WELCOME_BODY,
    footer: "Powered by Kapso",
    buttonText: "Select repo",
    sectionTitle: "Your repositories",
    rows: repos.slice(0, 10).map((repo) => ({
      id: `${REPO_PREFIX}${repo.fullName}`,
      title: repo.name.slice(0, 24), // Row title max 24 chars
      description: repo.owner,
    })),
  });
}

async function startSessionWithTask(
  to: string,
  githubRepo: string,
  task: string
): Promise<void> {
  settingUpSessions.add(to);

  try {
    await sendWhatsAppMessage(to, "Setting up your workspace...");

    const { client, branchName } = await getOrCreateClient(to, githubRepo);

    if (branchName) {
      await setupRepository(client, branchName, githubRepo);
      await sendWhatsAppMessage(
        to,
        `Ready ✅\n──────────\n📁 ${githubRepo}\n🔀 ${branchName}`
      );

      // Create message buffer for batching responses
      const buffer = new MessageBuffer(async (text) => {
        await sendWhatsAppMessage(to, text);
      });

      // Send the task to Claude
      await sendMessage(
        client,
        to,
        task,
        (responseText) => {
          buffer.append(responseText);
        },
        async (tool) => {
          // Combine any pending text with tool message
          const pendingText = buffer.take();
          const toolMessage = formatToolMessage(tool);
          const message = pendingText ? `${pendingText}\n${toolMessage}` : toolMessage;
          await sendWhatsAppMessage(to, message);
        }
      );

      await buffer.flush();
      await client.setTimeout(30 * 60 * 1000); // 30 minutes
    }
  } finally {
    settingUpSessions.delete(to);
  }
}

export async function handleMessage(message: ParsedMessage): Promise<void> {
  const { from, text, messageId, buttonId } = message;

  // Mark as read and show typing indicator
  await markAsReadWithTyping(messageId).catch(() => {});

  // Handle /reset command or reset button
  if (text.trim().toLowerCase() === "/reset" || buttonId === BUTTON_RESET) {
    await killClient(from);
    pendingRepos.delete(from);
    await sendWhatsAppMessage(
      from,
      "Session ended ✅\n──────────\nYour workspace has been closed.\n\nSend any message to start a new session."
    );
    return;
  }

  // Handle /info command
  if (text.trim().toLowerCase() === "/info") {
    const info = getSessionInfo(from);
    if (!info) {
      await sendWhatsAppMessage(from, "No active session.");
    } else {
      await sendWhatsAppMessage(
        from,
        `Status: ${info.status}\nRepo: ${info.githubRepo}\nBranch: ${info.branchName}\nSandbox: ${info.sandboxId}`
      );
    }
    return;
  }

  // Handle repo selection from buttons/list - store and ask for task
  if (isRepoSelection(buttonId)) {
    const selectedRepo = getRepoFromButtonId(buttonId!);
    pendingRepos.set(from, selectedRepo);
    await sendWhatsAppMessage(
      from,
      `📁 ${selectedRepo}\n\nWhat do you want to work on?`
    );
    return;
  }

  // Handle pending repo - user sent their task
  if (pendingRepos.has(from)) {
    const githubRepo = pendingRepos.get(from)!;
    pendingRepos.delete(from);
    try {
      await startSessionWithTask(from, githubRepo, text);
    } catch (error) {
      console.error("Error starting session:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      await sendWhatsAppMessage(
        from,
        `Failed to start session: ${errorMessage.slice(0, 200)}`
      );
    }
    return;
  }

  // Check if user has a paused session
  if (hasPausedSession(from)) {
    const info = getSessionInfo(from);
    await sendInteractiveButtons(from, {
      header: "Welcome back",
      body: `Your session is paused.\n\n📁 ${info?.githubRepo}\n🔀 ${info?.branchName || "unknown"}`,
      footer: "Powered by Kapso",
      buttons: [
        { id: BUTTON_CONTINUE, title: "Continue" },
        { id: BUTTON_RESET, title: "Start fresh" },
      ],
    });
    return;
  }

  // Skip if session is being set up (prevents race condition)
  if (settingUpSessions.has(from)) {
    return;
  }

  // Check if user has no session - show repo selection directly
  if (!hasActiveClient(from) && !isRepoSelection(buttonId) && buttonId !== BUTTON_CONTINUE) {
    try {
      const repos = await fetchAccessibleRepos();
      await showWelcomeWithRepos(from, repos);
    } catch (error) {
      console.error("Error fetching repos:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      await sendWhatsAppMessage(
        from,
        `Failed to fetch repositories: ${errorMessage.slice(0, 200)}`
      );
    }
    return;
  }

  // Continue existing session
  try {
    const info = getSessionInfo(from);
    const githubRepo = info?.githubRepo || "";

    const { client, isNew, branchName, resumed, sessionWasReset } = await getOrCreateClient(
      from,
      githubRepo
    );

    // Notify user if session was reset (failed to resume paused sandbox)
    if (sessionWasReset) {
      await sendWhatsAppMessage(
        from,
        "⚠️ Previous session expired. Starting fresh..."
      );
    }

    // Setup repository if new session (shouldn't happen here, but handle it)
    if (isNew && branchName) {
      await sendWhatsAppMessage(from, "Setting up your workspace...");
      await setupRepository(client, branchName, githubRepo);
      await sendWhatsAppMessage(
        from,
        `Ready ✅\n──────────\n📁 ${githubRepo}\n🔀 ${branchName}\n\nWhat do you want to work on?`
      );
      return;
    }

    // Notify if session was resumed
    if (resumed) {
      await sendWhatsAppMessage(from, `Session resumed on ${branchName}`);
    }

    // Don't process the button click as a message
    if (buttonId === BUTTON_CONTINUE) {
      return;
    }

    // Interrupt any ongoing processing before sending new message
    interruptSession(from);

    // Create message buffer for batching responses
    const buffer = new MessageBuffer(async (text) => {
      await sendWhatsAppMessage(from, text);
    });

    // Send message and stream responses
    await sendMessage(
      client,
      from,
      text,
      (responseText) => {
        buffer.append(responseText);
      },
      async (tool) => {
        // Combine any pending text with tool message
        const pendingText = buffer.take();
        const toolMessage = formatToolMessage(tool);
        const message = pendingText ? `${pendingText}\n${toolMessage}` : toolMessage;
        await sendWhatsAppMessage(from, message);
      }
    );

    // Flush any remaining buffered content
    await buffer.flush();

    // Reset inactivity timeout (5 minutes from now)
    await client.setTimeout(30 * 60 * 1000); // 30 minutes
  } catch (error) {
    console.error("Error handling message:", error);
    await killClient(from);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    await sendWhatsAppMessage(
      from,
      `Something went wrong: ${errorMessage.slice(0, 200)}`
    );
  }
}

export function startCleanupInterval(intervalMs = 30 * 60 * 1000): void {
  setInterval(async () => {
    // Placeholder for cleanup logic
  }, intervalMs);
}
