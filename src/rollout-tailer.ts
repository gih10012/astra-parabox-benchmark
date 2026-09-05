import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class RolloutTailer {
  readonly threadId: string;
  readonly sessionsRoot: string;
  #stopped = false;
  #filename: string | null = null;
  #offset = 0;
  #remainder = "";

  constructor(
    threadId: string,
    sessionsRoot = path.join(os.homedir(), ".codex/sessions"),
  ) {
    this.threadId = threadId;
    this.sessionsRoot = sessionsRoot;
  }

  stop(): void {
    this.#stopped = true;
  }

  async follow(onEvent: (event: unknown, raw: string) => Promise<void>): Promise<void> {
    while (!this.#stopped) {
      this.#filename ??= await findByName(this.sessionsRoot, this.threadId);
      if (!this.#filename) {
        await delay(200);
        continue;
      }
      const info = await stat(this.#filename);
      if (info.size > this.#offset) {
        const handle = await open(this.#filename, "r");
        try {
          const length = info.size - this.#offset;
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
          this.#offset += bytesRead;
          const lines = (this.#remainder + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
          this.#remainder = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              await onEvent(JSON.parse(line), line);
            } catch {
              // An incomplete or unknown event does not stop telemetry.
            }
          }
        } finally {
          await handle.close();
        }
      }
      await delay(200);
    }
  }
}

async function findByName(root: string, needle: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const filename = path.join(root, entry.name);
    if (entry.isFile() && entry.name.includes(needle)) return filename;
    if (entry.isDirectory()) {
      const nested = await findByName(filename, needle);
      if (nested) return nested;
    }
  }
  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
