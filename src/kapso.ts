import crypto from "crypto";
import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";

const KAPSO_API_BASE = "https://api.kapso.ai";

type KapsoConfig = {
  apiKey: string;
  phoneNumberId: string;
  webhookSecret: string;
};

let config: KapsoConfig;
let whatsapp: WhatsAppClient;

export function initKapso(cfg: KapsoConfig) {
  config = cfg;
  whatsapp = new WhatsAppClient({
    baseUrl: "https://api.kapso.ai/meta/whatsapp",
    kapsoApiKey: cfg.apiKey,
  });
}

// WhatsApp messaging

export async function sendWhatsAppMessage(to: string, text: string) {
  return whatsapp.messages.sendText({
    phoneNumberId: config.phoneNumberId,
    to,
    body: text,
  });
}

export async function markAsReadWithTyping(messageId: string) {
  return whatsapp.messages.markRead({
    phoneNumberId: config.phoneNumberId,
    messageId,
    typingIndicator: { type: "text" },
  });
}

type InteractiveButton = {
  id: string;
  title: string;
};

export async function sendInteractiveButtons(
  to: string,
  options: {
    header?: string;
    body: string;
    footer?: string;
    buttons: InteractiveButton[];
  }
) {
  return whatsapp.messages.sendInteractiveButtons({
    phoneNumberId: config.phoneNumberId,
    to,
    header: options.header ? { type: "text", text: options.header } : undefined,
    bodyText: options.body,
    footerText: options.footer,
    buttons: options.buttons,
  });
}

type ListRow = {
  id: string;
  title: string;
  description?: string;
};

export async function sendInteractiveList(
  to: string,
  options: {
    header?: string;
    body: string;
    footer?: string;
    buttonText: string;
    sectionTitle?: string;
    rows: ListRow[];
  }
) {
  return whatsapp.messages.sendInteractiveList({
    phoneNumberId: config.phoneNumberId,
    to,
    header: options.header ? { type: "text", text: options.header } : undefined,
    bodyText: options.body,
    footerText: options.footer,
    buttonText: options.buttonText,
    sections: [
      {
        title: options.sectionTitle,
        rows: options.rows,
      },
    ],
  });
}

// Webhook signature verification

export function verifyWebhookSignature(
  payload: string,
  signature: string
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", config.webhookSecret)
    .update(payload)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

// Database operations

type QueryFilter = {
  column: string;
  operator: "eq" | "gt" | "gte" | "lt" | "lte" | "like" | "in" | "is.null";
  value: string | number | boolean | null | string[];
};

async function dbRequest(
  method: string,
  table: string,
  options?: {
    filters?: QueryFilter[];
    data?: Record<string, unknown>;
    upsert?: boolean;
  }
) {
  const url = new URL(`${KAPSO_API_BASE}/platform/v1/database/${table}`);

  if (options?.filters) {
    for (const filter of options.filters) {
      const value =
        filter.operator === "in"
          ? `(${(filter.value as string[]).join(",")})`
          : String(filter.value);
      url.searchParams.append(filter.column, `${filter.operator}.${value}`);
    }
  }

  const fetchOptions: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
  };

  if (options?.data) {
    fetchOptions.body = JSON.stringify(options.data);
  }

  if (options?.upsert) {
    url.searchParams.append("upsert", "true");
  }

  const response = await fetch(url.toString(), fetchOptions);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Database ${method} failed: ${error}`);
  }

  return response.json();
}

export async function dbQuery<T>(
  table: string,
  filters?: QueryFilter[]
): Promise<T[]> {
  return dbRequest("GET", table, { filters });
}

export async function dbInsert(
  table: string,
  data: Record<string, unknown>
): Promise<void> {
  await dbRequest("POST", table, { data });
}

export async function dbUpsert(
  table: string,
  data: Record<string, unknown>
): Promise<void> {
  await dbRequest("POST", table, { data, upsert: true });
}

export async function dbUpdate(
  table: string,
  filters: QueryFilter[],
  data: Record<string, unknown>
): Promise<void> {
  await dbRequest("PATCH", table, { filters, data });
}

export async function dbDelete(
  table: string,
  filters: QueryFilter[]
): Promise<void> {
  await dbRequest("DELETE", table, { filters });
}

// Kapso webhook payload types - supports both batched and single message formats

export type KapsoWebhookPayload = {
  // Batched format
  type?: "whatsapp.message.received" | "whatsapp.message.sent" | "whatsapp.message.delivered" | "whatsapp.message.read";
  batch?: boolean;
  data?: Array<{
    message: KapsoMessage;
    conversation: KapsoConversation;
    phone_number_id: string;
  }>;
  // Single message format (forwarded Meta webhook)
  message?: KapsoMessage;
  conversation?: KapsoConversation;
  phone_number_id?: string;
};

type KapsoMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: "text" | "image" | "audio" | "video" | "document" | "location" | "interactive" | "button";
  text?: { body: string };
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { payload: string; text: string };
  kapso?: {
    direction: "inbound" | "outbound";
    content?: string;
  };
};

type KapsoConversation = {
  id: string;
  contact_name: string;
  phone_number: string;
};

export type ParsedMessage = {
  from: string;
  text: string;
  messageId: string;
  buttonId?: string;
};

function parseMessage(msg: KapsoMessage): ParsedMessage | null {
  if (msg.kapso?.direction !== "inbound") return null;

  // Text message
  if (msg.type === "text" && msg.text?.body) {
    return { from: msg.from, text: msg.text.body, messageId: msg.id };
  }

  // Interactive button reply
  if (msg.type === "interactive" && msg.interactive?.button_reply) {
    return {
      from: msg.from,
      text: msg.interactive.button_reply.title,
      messageId: msg.id,
      buttonId: msg.interactive.button_reply.id,
    };
  }

  // Interactive list reply
  if (msg.type === "interactive" && msg.interactive?.list_reply) {
    return {
      from: msg.from,
      text: msg.interactive.list_reply.title,
      messageId: msg.id,
      buttonId: msg.interactive.list_reply.id,
    };
  }

  // Button reply (older format)
  if (msg.type === "button" && msg.button) {
    return {
      from: msg.from,
      text: msg.button.text,
      messageId: msg.id,
      buttonId: msg.button.payload,
    };
  }

  return null;
}

export function parseWebhookPayload(payload: KapsoWebhookPayload): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  // Handle batched format
  if (payload.type && payload.data) {
    if (payload.type !== "whatsapp.message.received") {
      return messages;
    }
    for (const item of payload.data) {
      const parsed = parseMessage(item.message);
      if (parsed) messages.push(parsed);
    }
    return messages;
  }

  // Handle single message format
  if (payload.message) {
    const parsed = parseMessage(payload.message);
    if (parsed) messages.push(parsed);
  }

  return messages;
}
