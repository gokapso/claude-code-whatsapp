const WHATSAPP_MAX_LENGTH = 4096;

type MessageCallback = (text: string) => Promise<void>;

/**
 * Buffer for batching Claude responses before sending to WhatsApp.
 * Collects text and sends it in coherent chunks.
 */
export class MessageBuffer {
  private buffer: string[] = [];
  private callback: MessageCallback;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;

  constructor(callback: MessageCallback, debounceMs = 2000) {
    this.callback = callback;
    this.debounceMs = debounceMs;
  }

  append(text: string): void {
    if (!text.trim()) return;
    this.buffer.push(text);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.flushIfSignificant(), this.debounceMs);
  }

  private async flushIfSignificant(): Promise<void> {
    const content = this.buffer.join("\n").trim();
    if (content.length > 50) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const content = this.buffer.join("\n").trim();
    this.buffer = [];

    if (!content) return;

    // Split into WhatsApp-compatible chunks
    const chunks = this.splitIntoChunks(content);
    for (const chunk of chunks) {
      await this.callback(chunk);
    }
  }

  private splitIntoChunks(text: string): string[] {
    if (text.length <= WHATSAPP_MAX_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= WHATSAPP_MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point
      let breakPoint = WHATSAPP_MAX_LENGTH;

      // Try to break at paragraph
      const paragraphBreak = remaining.lastIndexOf("\n\n", WHATSAPP_MAX_LENGTH);
      if (paragraphBreak > WHATSAPP_MAX_LENGTH / 2) {
        breakPoint = paragraphBreak;
      } else {
        // Try to break at line
        const lineBreak = remaining.lastIndexOf("\n", WHATSAPP_MAX_LENGTH);
        if (lineBreak > WHATSAPP_MAX_LENGTH / 2) {
          breakPoint = lineBreak;
        } else {
          // Try to break at sentence
          const sentenceBreak = remaining.lastIndexOf(". ", WHATSAPP_MAX_LENGTH);
          if (sentenceBreak > WHATSAPP_MAX_LENGTH / 2) {
            breakPoint = sentenceBreak + 1;
          }
        }
      }

      chunks.push(remaining.slice(0, breakPoint).trim());
      remaining = remaining.slice(breakPoint).trim();
    }

    return chunks;
  }
}
