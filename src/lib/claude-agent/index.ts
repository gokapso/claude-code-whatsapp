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

    this.sandbox = await Sandbox.betaCreate(this.options.template!, {
      apiKey,
      timeoutMs: this.options.timeoutMs,
      autoPause: this.options.autoPause,
    });

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

    // Connect auto-resumes paused sandboxes
    const sandbox = await Sandbox.connect(sandboxId, { apiKey });

    const client = new ClaudeAgentClient(options);
    client.sandbox = sandbox;

    await client.waitForServer();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await client.configureAndConnect(anthropicApiKey);

    return client;
  }

  /** Wait for the server inside the sandbox to be ready */
  private async waitForServer(maxRetries = 10, delayMs = 1000): Promise<void> {
    const sandboxHost = this.sandbox!.getHost(SERVER_PORT);
    const configUrl = `https://${sandboxHost}/config`;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(configUrl, { method: "GET" });
        if (response.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error("Server did not become ready after resume");
  }

  /** Reset server state after resume (clears stale connections/streams) */
  private async restartServer(): Promise<void> {
    const sandboxHost = this.sandbox!.getHost(SERVER_PORT);
    const restartUrl = `https://${sandboxHost}/restart`;

    try {
      await fetch(restartUrl, { method: "POST" });
    } catch {
      // Ignore restart errors
    }
  }

  private async configureAndConnect(anthropicApiKey: string): Promise<void> {
    const sandboxHost = this.sandbox!.getHost(SERVER_PORT);
    const configUrl = `https://${sandboxHost}/config`;
    const wsUrl = `wss://${sandboxHost}/ws`;

    const configPayload = {
      anthropicApiKey,
      ...this.options,
    };

    const configResponse = await fetch(configUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configPayload),
    });

    if (!configResponse.ok) {
      const error = await configResponse.text();
      if (this.sandbox) {
        await this.sandbox.kill();
      }
      throw new Error(`Failed to configure server: ${error}`);
    }

    await this.connectWebSocket(wsUrl);
  }

  private async connectWebSocket(wsUrl: string, retries = 4): Promise<void> {
    const delays = [100, 250, 500, 1000];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.attemptWebSocketConnect(wsUrl);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt] || 1000));
        }
      }
    }

    throw lastError || new Error("WebSocket connection failed");
  }

  private attemptWebSocketConnect(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      let stabilityTimer: ReturnType<typeof setTimeout> | null = null;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (stabilityTimer) clearTimeout(stabilityTimer);
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        reject(error);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        if (stabilityTimer) clearTimeout(stabilityTimer);
        this.ws = ws;
        this.setupWebSocketHandlers();
        resolve();
      };

      ws.onopen = () => {
        // Wait 200ms to verify connection is stable (E2B proxy may drop it immediately)
        stabilityTimer = setTimeout(() => {
          if (!settled && ws.readyState === WebSocket.OPEN) {
            succeed();
          }
        }, 200);
      };

      ws.onerror = (error) => {
        fail(error instanceof Error ? error : new Error("WebSocket error"));
      };

      ws.onclose = (event) => {
        if (!settled) {
          fail(new Error(`WebSocket closed: code=${event.code}`));
        }
      };

      // Timeout for initial connection
      setTimeout(() => {
        if (!settled) {
          fail(new Error("WebSocket connection timeout"));
          try { ws.close(); } catch {}
        }
      }, 5000);
    });
  }

  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(
          event.data.toString()
        ) as WSOutputMessage;
        this.handleMessage(message);
      } catch {
        // Ignore parse errors
      }
    };

    this.ws.onclose = () => {};
    this.ws.onerror = () => {};
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

  get isConnected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  send(message: WSInputMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  /** Interrupt the current query if one is in progress */
  interrupt(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return; // No connection, nothing to interrupt
    }
    this.ws.send(JSON.stringify({ type: "interrupt" }));
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

  /** Run a shell command directly on the sandbox */
  async runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    const result = await this.sandbox.commands.run(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
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
      await this.sandbox.betaPause();
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
