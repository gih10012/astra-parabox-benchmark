#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { allowedKeys } from "./types.js";

const arenaUrl = process.env.ARENA_URL;
const controlToken = process.env.ARENA_CONTROL_TOKEN;
if (!arenaUrl || !controlToken) {
  throw new Error("ARENA_URL and ARENA_CONTROL_TOKEN are required");
}

async function request<T>(
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(new URL(pathname, arenaUrl), {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${controlToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

interface FramePayload {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  sha256: string;
  capturedAt: string;
}

const server = new McpServer({ name: "parabox-arena", version: "0.1.0" });

server.registerTool(
  "observe_game",
  {
    title: "Observe game",
    description: "Capture the current game window.",
    inputSchema: {},
  },
  async () => {
    const frame = await request<FramePayload>("/internal/observe", {
      method: "POST",
      body: "{}",
    });
    return {
      content: [
        { type: "image" as const, data: frame.data, mimeType: frame.mimeType },
        {
          type: "text" as const,
          text: JSON.stringify({
            sha256: frame.sha256,
            capturedAt: frame.capturedAt,
          }),
        },
      ],
    };
  },
);

server.registerTool(
  "press_keys",
  {
    title: "Press keys",
    description:
      "Press a sequence of keyboard keys in the game window. Returns the resulting frame unless capture is false.",
    inputSchema: {
      keys: z.array(z.enum(allowedKeys)).min(1).max(512),
      intervalMs: z.number().int().min(0).max(1000).default(55),
      settleMs: z.number().int().min(0).max(2000).default(100),
      capture: z.boolean().default(true),
    },
  },
  async ({ keys, intervalMs, settleMs, capture }) => {
    const result = await request<{
      pressed: number;
      frame: FramePayload | null;
    }>("/internal/press", {
      method: "POST",
      body: JSON.stringify({ keys, intervalMs, settleMs, capture }),
    });
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [
      {
        type: "text",
        text: JSON.stringify({ pressed: result.pressed }),
      },
    ];
    if (result.frame) {
      content.push({
        type: "image",
        data: result.frame.data,
        mimeType: result.frame.mimeType,
      });
    }
    return { content };
  },
);

server.registerTool(
  "challenge_time",
  {
    title: "Challenge time",
    description: "Return the official monotonic elapsed challenge time.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(await request("/api/challenge/time")),
      },
    ],
  }),
);

server.registerTool(
  "challenge_tokens",
  {
    title: "Challenge token usage",
    description: "Return the latest cumulative Codex token usage sample.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(await request("/api/challenge/tokens")),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
