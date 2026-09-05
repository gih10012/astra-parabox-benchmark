import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const providerKeys = new Set([
  "name",
  "base_url",
  "wire_api",
  "env_key",
  "requires_openai_auth",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
  "supports_websockets",
]);

export interface ProviderConfigSelection {
  id: string;
  assignments: Array<{ key: string; tomlValue: string }>;
}

export async function loadProviderConfig(
  filename = path.join(os.homedir(), ".codex/config.toml"),
): Promise<ProviderConfigSelection | null> {
  let text: string;
  try {
    text = await readFile(filename, "utf8");
  } catch {
    return null;
  }
  return parseProviderConfig(text);
}

export function parseProviderConfig(text: string): ProviderConfigSelection | null {
  const lines = text.split(/\r?\n/);
  let modelProvider: string | null = null;
  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (line.startsWith("[")) break;
    const assignment = parseAssignment(line);
    if (assignment?.key === "model_provider") {
      modelProvider = parseTomlString(assignment.value);
      break;
    }
  }
  if (!modelProvider || modelProvider === "openai") return null;

  const sectionNames = new Set([
    `[model_providers.${modelProvider}]`,
    `[model_providers.${JSON.stringify(modelProvider)}]`,
  ]);
  let inProvider = false;
  const assignments: Array<{ key: string; tomlValue: string }> = [
    { key: "model_provider", tomlValue: JSON.stringify(modelProvider) },
  ];
  const segment = /^[A-Za-z0-9_-]+$/.test(modelProvider)
    ? modelProvider
    : JSON.stringify(modelProvider);
  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (line.startsWith("[")) {
      inProvider = sectionNames.has(line);
      continue;
    }
    if (!inProvider) continue;
    const assignment = parseAssignment(line);
    if (!assignment || !providerKeys.has(assignment.key)) continue;
    assignments.push({
      key: `model_providers.${segment}.${assignment.key}`,
      tomlValue: assignment.value,
    });
  }
  return assignments.length > 1 ? { id: modelProvider, assignments } : null;
}

function parseAssignment(line: string): { key: string; value: string } | null {
  const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
  return match?.[1] && match[2]
    ? { key: match[1], value: match[2].trim() }
    : null;
}

function parseTomlString(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    const single = /^'([^']*)'$/.exec(value);
    return single?.[1] ?? null;
  }
}

function stripComment(line: string): string {
  let quoted = false;
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") {
      if (!quoted) {
        quoted = true;
        quote = character;
      } else if (quote === character) quoted = false;
    }
    if (character === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}
