import "dotenv/config";
import express from "express";
import {
  initKapso,
  verifyWebhookSignature,
  parseWebhookPayload,
  type KapsoWebhookPayload,
} from "./kapso.js";
import { handleMessage, startCleanupInterval } from "./handler.js";

// Validate required environment variables
const requiredEnvVars = [
  "ANTHROPIC_API_KEY",
  "E2B_API_KEY",
  "KAPSO_API_KEY",
  "PHONE_NUMBER_ID",
  "GITHUB_TOKEN",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Initialize Kapso client
initKapso({
  apiKey: process.env.KAPSO_API_KEY!,
  phoneNumberId: process.env.PHONE_NUMBER_ID!,
  webhookSecret: process.env.WEBHOOK_SECRET!,
});

// Create Express app
const app = express();

// Store raw body for signature verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody: string }).rawBody = buf.toString();
    },
  })
);

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Webhook endpoint for Kapso
app.post("/webhook", (req, res) => {
  const signature = req.headers["x-webhook-signature"];
  const rawBody = (req as express.Request & { rawBody: string }).rawBody;

  // Verify webhook signature (skip if no secret configured)
  if (process.env.WEBHOOK_SECRET) {
    if (typeof signature !== "string" || !verifyWebhookSignature(rawBody, signature)) {
      console.warn("Invalid webhook signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  }

  // Respond immediately - process async
  res.status(200).json({ status: "received" });

  // Parse and process messages
  const payload = req.body as KapsoWebhookPayload;
  const messages = parseWebhookPayload(payload);

  for (const message of messages) {
    // Process each message asynchronously
    handleMessage(message).catch((error) => {
      console.error("Error processing message:", error);
    });
  }
});

// Start server
const port = process.env.PORT ? parseInt(process.env.PORT) : 3001;

app.listen(port, () => {
  console.log(`Claude Code WhatsApp server running on port ${port}`);
  console.log(`Webhook endpoint: POST /webhook`);
  console.log(`Health check: GET /health`);
});

// Start periodic cleanup
startCleanupInterval();

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down...");
  process.exit(0);
});

// Prevent crashes from unhandled errors
process.on("uncaughtException", (error) => {
  console.error("\n========== UNCAUGHT EXCEPTION ==========");
  console.error(error);
  console.error("=========================================\n");
});

process.on("unhandledRejection", (reason) => {
  console.error("\n========== UNHANDLED REJECTION ==========");
  console.error(reason);
  console.error("==========================================\n");
});
