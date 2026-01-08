import crypto from "crypto";

const KAPSO_API_BASE = "https://api.kapso.ai";
const WHATSAPP_API_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";

type KapsoConfig = {
  apiKey: string;
  phoneNumberId: string;
  webhookSecret: string;
};

let config: KapsoConfig;

export function initKapso(cfg: KapsoConfig) {
  config = cfg;
}

// WhatsApp messaging

export async function sendWhatsAppMessage(to: string, text: string) {
  const response = await fetch(
    `${WHATSAPP_API_BASE}/${config.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send WhatsApp message: ${error}`);
  }

  return response.json();
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
  type: "text" | "image" | "audio" | "video" | "document" | "location";
  text?: { body: string };
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

export function parseWebhookPayload(payload: KapsoWebhookPayload) {
  const messages: Array<{ from: string; text: string; messageId: string }> = [];

  // Handle batched format
  if (payload.type && payload.data) {
    if (payload.type !== "whatsapp.message.received") {
      return messages;
    }
    for (const item of payload.data) {
      const msg = item.message;
      if (msg.type === "text" && msg.text?.body && msg.kapso?.direction === "inbound") {
        messages.push({
          from: msg.from,
          text: msg.text.body,
          messageId: msg.id,
        });
      }
    }
    return messages;
  }

  // Handle single message format
  if (payload.message) {
    const msg = payload.message;
    if (msg.type === "text" && msg.text?.body && msg.kapso?.direction === "inbound") {
      messages.push({
        from: msg.from,
        text: msg.text.body,
        messageId: msg.id,
      });
    }
  }

  return messages;
}
