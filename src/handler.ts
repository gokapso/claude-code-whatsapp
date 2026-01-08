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

function truncate(str: string, maxLines: number, maxChars: number): string {
  const lines = str.split("\n").slice(0, maxLines);
  const result = lines.join("\n");
  return result.length > maxChars ? result.slice(0, maxChars) + "..." : result;
}

function formatDiffLines(str: string, prefix: string, maxLines = 6): string {
  return str
    .split("\n")
    .slice(0, maxLines)
    .map((line) => `${prefix} ${line}`)
    .join("\n");
}

function formatToolMessage(name: string, input: ToolInput): string {
  const divider = "──────────";

  switch (name) {
    case "Edit": {
      const file = input.file_path?.split("/").pop() || "file";
      const oldLines = input.old_string
        ? formatDiffLines(truncate(input.old_string, 6, 200), "-")
        : "";
      const newLines = input.new_string
        ? formatDiffLines(truncate(input.new_string, 6, 200), "+")
        : "";
      return `📝 Edit\n${divider}\n${file}\n\n${oldLines}\n\n${newLines}`;
    }

    case "Write": {
      const file = input.file_path?.split("/").pop() || "file";
      const preview = input.content ? truncate(input.content, 4, 150) : "";
      return `📝 Write\n${divider}\n${file}\n\n${preview}`;
    }

    case "Read": {
      const file = input.file_path?.split("/").pop() || "file";
      return `📖 Read\n${divider}\n${file}`;
    }

    case "Bash": {
      const cmd = input.command ? truncate(input.command, 3, 100) : "";
      return `⚡ Bash\n${divider}\n${cmd}`;
    }

    case "Glob":
    case "Grep": {
      const pattern = input.pattern || "";
      const path = input.path ? ` in ${input.path}` : "";
      return `🔍 ${name}\n${divider}\n"${pattern}"${path}`;
    }

    default: {
      return `🔧 ${name}`;
    }
  }
}

const BUTTON_CONTINUE = "continue_session";
const BUTTON_RESET = "reset_session";
const REPO_PREFIX = "repo:";

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

async function startSession(to: string, githubRepo: string): Promise<void> {
  await sendWhatsAppMessage(to, "Setting up your workspace...");

  const { client, branchName } = await getOrCreateClient(to, githubRepo);

  if (branchName) {
    await setupRepository(client, branchName, githubRepo);
    await sendWhatsAppMessage(
      to,
      `Ready ✅\n──────────\n📁 ${githubRepo}\n🌿 ${branchName}\n\nWhat do you want to work on?`
    );
  }
}

export async function handleMessage(message: ParsedMessage): Promise<void> {
  const { from, text, messageId, buttonId } = message;

  // Mark as read and show typing indicator
  await markAsReadWithTyping(messageId).catch(() => {});

  // Handle /reset command or reset button
  if (text.trim().toLowerCase() === "/reset" || buttonId === BUTTON_RESET) {
    await killClient(from);
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

  // Handle repo selection from buttons/list
  if (isRepoSelection(buttonId)) {
    const selectedRepo = getRepoFromButtonId(buttonId!);
    try {
      await startSession(from, selectedRepo);
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
      body: `Your session is paused.\n\n📁 ${info?.githubRepo}\n🌿 ${info?.branchName || "unknown"}`,
      footer: "Powered by Kapso",
      buttons: [
        { id: BUTTON_CONTINUE, title: "Continue" },
        { id: BUTTON_RESET, title: "Start fresh" },
      ],
    });
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

    const { client, isNew, branchName, resumed } = await getOrCreateClient(
      from,
      githubRepo
    );

    // Setup repository if new session (shouldn't happen here, but handle it)
    if (isNew && branchName) {
      await sendWhatsAppMessage(from, "Setting up your workspace...");
      await setupRepository(client, branchName, githubRepo);
      await sendWhatsAppMessage(
        from,
        `Ready ✅\n──────────\n📁 ${githubRepo}\n🌿 ${branchName}\n\nWhat do you want to work on?`
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
        const message = formatToolMessage(tool.name, tool.input as ToolInput);
        await sendWhatsAppMessage(from, message);
      }
    );

    // Flush any remaining buffered content
    await buffer.flush();

    // Reset inactivity timeout (5 minutes from now)
    await client.setTimeout(5 * 60 * 1000);
  } catch (error) {
    console.error(`\n========== ERROR ==========`);
    console.error(`Error handling message from ${from}:`);
    console.error(error);
    console.error(`===========================\n`);

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
    console.log("Running client cleanup...");
  }, intervalMs);
}
