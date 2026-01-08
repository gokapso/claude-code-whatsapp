import { sendWhatsAppMessage } from "./kapso.js";
import {
  getOrCreateClient,
  setupRepository,
  sendMessage,
  killClient,
} from "./claude.js";
import { MessageBuffer } from "./formatter.js";

type IncomingMessage = {
  from: string;
  text: string;
  messageId: string;
};

export async function handleMessage(message: IncomingMessage): Promise<void> {
  const { from, text } = message;
  const githubRepo = process.env.GITHUB_REPO!;

  console.log(`Processing message from ${from}: ${text.slice(0, 50)}...`);

  try {
    // Get or create client for this contact
    const { client, isNew } = await getOrCreateClient(from);

    // Setup repository if new session
    if (isNew) {
      await sendWhatsAppMessage(
        from,
        `Setting up workspace with ${githubRepo}...`
      );
      await setupRepository(client);
      await sendWhatsAppMessage(from, "Ready! Processing your request...");
    }

    // Create message buffer for batching responses
    const buffer = new MessageBuffer(async (text) => {
      await sendWhatsAppMessage(from, text);
    });

    // Send message and stream responses
    await sendMessage(client, from, text, (responseText) => {
      buffer.append(responseText);
    });

    // Flush any remaining buffered content
    await buffer.flush();
  } catch (error) {
    console.error(`\n========== ERROR ==========`);
    console.error(`Error handling message from ${from}:`);
    console.error(error);
    console.error(`===========================\n`);

    // Clean up failed client
    await killClient(from);

    // Notify user of error
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    await sendWhatsAppMessage(
      from,
      `Sorry, something went wrong: ${errorMessage.slice(0, 200)}`
    );
  }
}

// Clean up inactive clients periodically
export function startCleanupInterval(intervalMs = 30 * 60 * 1000): void {
  setInterval(async () => {
    console.log("Running client cleanup...");
    // In production, you'd track last activity and kill idle clients
  }, intervalMs);
}
