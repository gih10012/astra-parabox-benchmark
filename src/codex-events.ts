import type { TokenUsage } from "./types.js";

type JsonObject = Record<string, unknown>;

const zeroUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function normalize(raw: JsonObject): TokenUsage {
  const inputTokens = nonNegative(raw.input_tokens ?? raw.inputTokens);
  const cachedInputTokens = nonNegative(
    raw.cached_input_tokens ?? raw.cachedInputTokens,
  );
  const outputTokens = nonNegative(raw.output_tokens ?? raw.outputTokens);
  const reasoningOutputTokens = nonNegative(
    raw.reasoning_output_tokens ?? raw.reasoningOutputTokens,
  );
  const reportedTotal = nonNegative(raw.total_tokens ?? raw.totalTokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
  };
}

export function extractTokenUsage(event: unknown): {
  usage: TokenUsage;
  source: "rollout" | "exec";
} | null {
  const root = object(event);
  if (!root) return null;

  if (root.type === "turn.completed") {
    const usage = object(root.usage);
    return usage ? { usage: normalize(usage), source: "exec" } : null;
  }

  if (root.type === "event_msg") {
    const payload = object(root.payload);
    if (payload?.type !== "token_count") return null;
    const info = object(payload.info);
    const total = object(info?.total_token_usage);
    return total ? { usage: normalize(total), source: "rollout" } : null;
  }

  return null;
}

export function mergeUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  if (next.totalTokens >= current.totalTokens) return next;
  return current;
}

export function emptyTokenUsage(): TokenUsage {
  return zeroUsage();
}

export function publicTranscriptEvent(event: unknown): unknown | null {
  const root = object(event);
  if (!root || typeof root.type !== "string") return null;
  if (root.type === "thread.started" || root.type.startsWith("turn.")) {
    return root;
  }
  if (!root.type.startsWith("item.")) return null;
  const item = object(root.item);
  if (!item) return null;
  const type = typeof item.type === "string" ? item.type : "unknown";
  const visible: JsonObject = {
    type: root.type,
    item: { type, status: item.status ?? null },
  };
  if (type === "agent_message" || type === "reasoning") {
    (visible.item as JsonObject).text = item.text ?? "";
  } else if (type === "mcp_tool_call") {
    (visible.item as JsonObject).server = item.server ?? null;
    (visible.item as JsonObject).tool = item.tool ?? item.name ?? null;
    (visible.item as JsonObject).arguments = item.arguments ?? null;
    (visible.item as JsonObject).result = item.result ?? null;
    (visible.item as JsonObject).error = item.error ?? null;
  }
  return visible;
}
