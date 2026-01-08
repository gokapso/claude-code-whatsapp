/**
 * Claude Agent Client with E2B sandbox support
 * Based on @dzhng/claude-agent - https://github.com/dzhng/claude-agent-server
 *
 * Extended with:
 * - autoPause option (pause on timeout instead of kill)
 * - sandboxId getter
 * - pause() method
 * - static connect() to resume paused sandboxes
 * - setTimeout() to extend timeout
 */

import { Sandbox, type FilesystemEvent } from "e2b";

import { DEFAULT_TEMPLATE, SERVER_PORT, WORKSPACE_DIR_NAME } from "./const.js";
import type {
  ClientOptions,
  WatchHandle,
  WSInputMessage,
  WSOutputMessage,
} from "./types.js";

export class ClaudeAgentClient {
  private sandbox?: Sandbox;
  private ws?: WebSocket;
  private options: ClientOptions;
  private messageHandlers: ((message: WSOutputMessage) => void)[] = [];

  constructor(options: ClientOptions = {}) {
    this.options = {
      template: DEFAULT_TEMPLATE,
      timeoutMs: 30 * 60 * 1000, // 30 minutes default
      autoPause: true, // Pause on timeout by default
      ...options,
    };
  }

  /** Get the sandbox ID (for storing/resuming) */
  get sandboxId(): string | undefined {
    return this.sandbox?.sandboxId;
  }

  async start(): Promise<void> {
    const apiKey = this.options.e2bApiKey || process.env.E2B_API_KEY;
    const anthropicApiKey =
      this.options.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("E2B_API_KEY is required");
    }

    if (!anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is required");
    }

    if (this.options.debug) {
      console.log(`🚀 Creating sandbox from ${this.options.template}...`);
    }

    this.sandbox = await Sandbox.create(this.options.template!, {
      apiKey,
      timeoutMs: this.options.timeoutMs,
      // @ts-expect-error - autoPause is in beta API
      autoPause: this.options.autoPause,
    });

    if (this.options.debug) {
      console.log(`✅ Sandbox created: ${this.sandbox.sandboxId}`);
    }

    await this.configureAndConnect(anthropicApiKey);
  }

  /** Resume a paused sandbox by its ID */
  static async connect(
    sandboxId: string,
    options: ClientOptions = {}
  ): Promise<ClaudeAgentClient> {
    const apiKey = options.e2bApiKey || process.env.E2B_API_KEY;
    const anthropicApiKey =
      options.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("E2B_API_KEY is required");
    }

    if (!anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is required");
    }

    if (options.debug) {
      console.log(`🔄 Resuming sandbox ${sandboxId}...`);
    }

    // Connect auto-resumes paused sandboxes
    const sandbox = await Sandbox.connect(sandboxId, { apiKey });

    if (options.debug) {
      console.log(`✅ Sandbox resumed: ${sandbox.sandboxId}`);
    }

    const client = new ClaudeAgentClient(options);
    client.sandbox = sandbox;

    await client.configureAndConnect(anthropicApiKey);

    return client;
  }

  private async configureAndConnect(anthropicApiKey: string): Promise<void> {
    const sandboxHost = this.sandbox!.getHost(SERVER_PORT);
    const configUrl = `https://${sandboxHost}/config`;
    const wsUrl = `wss://${sandboxHost}/ws`;

    if (this.options.debug) {
      console.log(`📡 Configuring server at ${configUrl}...`);
    }

    const configResponse = await fetch(configUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anthropicApiKey,
        ...this.options,
      }),
    });

    if (!configResponse.ok) {
      const error = await configResponse.text();
      if (this.sandbox) {
        await this.sandbox.kill();
      }
      throw new Error(`Failed to configure server: ${error}`);
    }

    if (this.options.debug) {
      console.log("🔌 Connecting to WebSocket...");
    }

    await this.connectWebSocket(wsUrl);
  }

  private async connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        if (this.options.debug) console.log("✅ Connected to Claude Agent SDK");
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(
            event.data.toString()
          ) as WSOutputMessage;
          this.handleMessage(message);
        } catch (error) {
          console.error("Failed to parse message:", error);
        }
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        reject(error);
      };

      this.ws.onclose = () => {
        if (this.options.debug) console.log("👋 Disconnected");
      };
    });
  }

  private handleMessage(message: WSOutputMessage): void {
    this.messageHandlers.forEach((handler) => handler(message));
  }

  onMessage(handler: (message: WSOutputMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  send(message: WSInputMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  private resolvePath(path: string): string {
    if (path.startsWith("/")) {
      return path;
    }
    if (path === ".") {
      return `/home/user/${WORKSPACE_DIR_NAME}`;
    }
    return `/home/user/${WORKSPACE_DIR_NAME}/${path}`;
  }

  async writeFile(path: string, content: string | Blob): Promise<void> {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    await this.sandbox.files.write(this.resolvePath(path), content);
  }

  async readFile(
    path: string,
    format: "text" | "blob"
  ): Promise<string | Blob> {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    const resolvedPath = this.resolvePath(path);
    if (format === "blob") {
      return this.sandbox.files.read(resolvedPath, { format });
    }
    return this.sandbox.files.read(resolvedPath);
  }

  async removeFile(path: string): Promise<void> {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    return this.sandbox.files.remove(this.resolvePath(path));
  }

  async listFiles(path = "."): Promise<Awaited<ReturnType<Sandbox["files"]["list"]>>> {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    return this.sandbox.files.list(this.resolvePath(path));
  }

  async watchDir(
    path: string,
    onEvent: (event: FilesystemEvent) => void | Promise<void>,
    opts?: {
      recursive?: boolean;
      onExit?: (err?: Error) => void | Promise<void>;
    }
  ): Promise<WatchHandle> {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    return this.sandbox.files.watchDir(this.resolvePath(path), onEvent, opts);
  }

  /** Extend the sandbox timeout */
  async setTimeout(timeoutMs: number): Promise<void> {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    await this.sandbox.setTimeout(timeoutMs);
  }

  /** Pause the sandbox (can be resumed later with connect()) */
  async pause(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    if (this.sandbox) {
      // @ts-expect-error - pause is in beta API
      await this.sandbox.pause();
    }
  }

  /** Stop and kill the sandbox (cannot be resumed) */
  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
    }
    if (this.sandbox) {
      await this.sandbox.kill();
    }
  }
}

// Re-export types
export * from "./types.js";
export * from "./const.js";
