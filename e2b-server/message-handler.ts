import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ServerWebSocket } from "bun";

import { type WSInputMessage, type WSOutputMessage } from "./message-types";

export type MessageHandlerContext = {
  messageQueue: SDKUserMessage[];
  getActiveStream: () => ReturnType<typeof query> | null;
};

export async function handleMessage(
  ws: ServerWebSocket,
  message: string | Buffer,
  context: MessageHandlerContext
) {
  try {
    const input = JSON.parse(message.toString()) as WSInputMessage;
    const { messageQueue, getActiveStream } = context;

    if (input.type === "user_message") {
      messageQueue.push(input.data);
    } else if (input.type === "interrupt") {
      getActiveStream()?.interrupt();
    }
  } catch (error) {
    ws.send(
      JSON.stringify({
        type: "error",
        error: `Invalid message format: ${error instanceof Error ? error.message : String(error)}`,
      } as WSOutputMessage)
    );
  }
}
