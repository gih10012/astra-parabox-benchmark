import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface AuditRecord {
  at: string;
  type: string;
  data: unknown;
}

export function createRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export class AuditLog {
  readonly runDirectory: string;
  readonly eventsPath: string;

  constructor(runDirectory: string) {
    this.runDirectory = runDirectory;
    this.eventsPath = path.join(runDirectory, "events.jsonl");
  }

  async initialize(metadata: unknown): Promise<void> {
    await mkdir(this.runDirectory, { recursive: true });
    await writeFile(
      path.join(this.runDirectory, "run.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: "wx" },
    );
    await this.append("run.initialized", metadata);
  }

  async append(type: string, data: unknown): Promise<void> {
    const record: AuditRecord = { at: new Date().toISOString(), type, data };
    await appendFile(this.eventsPath, `${JSON.stringify(record)}\n`);
  }

  async appendRaw(filename: string, line: string): Promise<void> {
    await appendFile(path.join(this.runDirectory, filename), `${line}\n`);
  }

  async finalize(summary: unknown): Promise<void> {
    await writeFile(
      path.join(this.runDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    const files = await listFiles(this.runDirectory);
    const hashes: Record<string, string> = {};
    for (const filename of files) {
      if (filename === "manifest.sha256.json") continue;
      hashes[filename] = await sha256File(path.join(this.runDirectory, filename));
    }
    await writeFile(
      path.join(this.runDirectory, "manifest.sha256.json"),
      `${JSON.stringify(hashes, null, 2)}\n`,
    );
  }
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, next)));
    else if (entry.isFile()) files.push(next);
  }
  return files.sort();
}

async function sha256File(filename: string): Promise<string> {
  const handle = await open(filename, "r");
  const hash = createHash("sha256");
  try {
    const info = await stat(filename);
    let offset = 0;
    while (offset < info.size) {
      const length = Math.min(1024 * 1024, info.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
