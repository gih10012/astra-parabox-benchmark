import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChallengeState } from "./challenge-state.js";
import type { GameAdapter, GameFrame } from "./types.js";
import { allowedKeys, type AllowedKey } from "./types.js";

const publicRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  import.meta.url.includes("/dist/") ? "../../web" : "../web",
);

interface ControllerOptions {
  state: ChallengeState;
  game: GameAdapter;
  host?: string;
  port?: number;
  webRoot?: string;
  controlToken?: string;
}

interface TranscriptRecord {
  sequence: number;
  at: string;
  event: unknown;
}

export class ArenaController {
  readonly state: ChallengeState;
  readonly game: GameAdapter;
  readonly host: string;
  readonly requestedPort: number;
  readonly webRoot: string;
  readonly controlToken: string;
  readonly transcript: TranscriptRecord[] = [];
  #server: Server | null = null;
  #clients = new Set<ServerResponse>();
  #frame: GameFrame | null = null;
  #transcriptSequence = 0;

  constructor(options: ControllerOptions) {
    this.state = options.state;
    this.game = options.game;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 4317;
    this.webRoot = options.webRoot ?? publicRoot;
    this.controlToken =
      options.controlToken ?? randomBytes(24).toString("base64url");
    this.state.on("change", (snapshot) => {
      this.broadcast("state", snapshot);
    });
  }

  get url(): string {
    if (!this.#server) throw new Error("Controller is not listening");
    const address = this.#server.address();
    if (!address || typeof address === "string") {
      throw new Error("Controller address unavailable");
    }
    return `http://${this.host}:${address.port}`;
  }

  async listen(): Promise<string> {
    if (this.#server) return this.url;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const status =
          error instanceof Error && "statusCode" in error
            ? Number((error as Error & { statusCode: number }).statusCode)
            : 500;
        json(response, status, { error: message });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.requestedPort, this.host, () => resolve());
    });
    return this.url;
  }

  async close(): Promise<void> {
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    if (!this.#server) return;
    const server = this.#server;
    this.#server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  publishTranscript(event: unknown): void {
    const record: TranscriptRecord = {
      sequence: ++this.#transcriptSequence,
      at: new Date().toISOString(),
      event,
    };
    this.transcript.push(record);
    if (this.transcript.length > 1_000) this.transcript.shift();
    this.broadcast("transcript", record);
  }

  broadcast(name: string, data: unknown): void {
    const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.#clients) client.write(payload);
  }

  async #handle(
    request: import("node:http").IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${this.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/challenge/time") {
      json(response, 200, this.state.timeSnapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/challenge/tokens") {
      json(response, 200, this.state.tokenSnapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/challenge") {
      json(response, 200, this.state.snapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/transcript") {
      json(response, 200, this.transcript);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/frame") {
      if (!this.#frame) {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": this.#frame.mimeType,
        "Cache-Control": "no-store",
        ETag: `"${this.#frame.sha256}"`,
      });
      response.end(this.#frame.data);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.write(`event: state\ndata: ${JSON.stringify(this.state.snapshot())}\n\n`);
      this.#clients.add(response);
      request.on("close", () => this.#clients.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/observe") {
      this.#authorize(request);
      this.#frame = await this.game.capture();
      this.broadcast("frame", {
        sha256: this.#frame.sha256,
        capturedAt: this.#frame.capturedAt,
      });
      json(response, 200, serializeFrame(this.#frame));
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/press") {
      this.#authorize(request);
      const body = await readJson(request);
      const keys = parseKeys(body.keys);
      const intervalMs = boundedInteger(body.intervalMs, 0, 1_000, 55);
      const settleMs = boundedInteger(body.settleMs, 0, 2_000, 100);
      const capture = body.capture !== false;
      await this.game.press(keys, { intervalMs, settleMs });
      if (capture) {
        this.#frame = await this.game.capture();
        this.broadcast("frame", {
          sha256: this.#frame.sha256,
          capturedAt: this.#frame.capturedAt,
        });
      }
      json(response, 200, {
        pressed: keys.length,
        frame: this.#frame && capture ? serializeFrame(this.#frame) : null,
      });
      return;
    }

    const staticFiles: Record<string, { name: string; type: string }> = {
      "/": { name: "index.html", type: "text/html; charset=utf-8" },
      "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
      "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
      "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
    };
    const file = staticFiles[url.pathname];
    if (request.method === "GET" && file) {
      const body = await readFile(path.join(this.webRoot, file.name));
      response.writeHead(200, {
        "Content-Type": file.type,
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; style-src 'self'",
        "Cache-Control": "no-cache",
      });
      response.end(body);
      return;
    }
    json(response, 404, { error: "not found" });
  }

  #authorize(request: import("node:http").IncomingMessage): void {
    if (request.headers.authorization !== `Bearer ${this.controlToken}`) {
      const error = new Error("unauthorized") as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
  }
}

function serializeFrame(frame: GameFrame) {
  return {
    data: frame.data.toString("base64"),
    mimeType: frame.mimeType,
    width: frame.width ?? null,
    height: frame.height ?? null,
    sha256: frame.sha256,
    capturedAt: frame.capturedAt,
  };
}

function parseKeys(value: unknown): AllowedKey[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    throw new Error("keys must contain 1 to 512 entries");
  }
  const accepted = new Set<string>(allowedKeys);
  const keys = value.map((key) => String(key).toUpperCase());
  if (keys.some((key) => !accepted.has(key))) throw new Error("unsupported key");
  return keys as AllowedKey[];
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new Error("timing must be an integer");
  const number = value as number;
  if (number < minimum || number > maximum) throw new Error("timing out of range");
  return number;
}

async function readJson(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 32_768) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON object required");
  }
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}
