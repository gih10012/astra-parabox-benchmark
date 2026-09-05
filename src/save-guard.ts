import {
  copyFile,
  mkdir,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

interface RecoveryEntry {
  original: string;
  backup: string;
}

interface RecoveryPlan {
  createdAt: string;
  saveDirectory: string;
  entries: RecoveryEntry[];
  restoredAt?: string;
}

export class SaveGuard {
  readonly saveDirectory: string;
  readonly runDirectory: string;
  readonly recoveryPath: string;
  #plan: RecoveryPlan | null = null;

  constructor(saveDirectory: string, runDirectory: string) {
    this.saveDirectory = saveDirectory;
    this.runDirectory = runDirectory;
    this.recoveryPath = path.join(runDirectory, "save-recovery.json");
  }

  async prepare(): Promise<void> {
    await stat(this.saveDirectory);
    const backupDirectory = path.join(this.runDirectory, "save-backup");
    await mkdir(backupDirectory, { recursive: true });
    const names = (await readdir(this.saveDirectory)).filter((name) =>
      /^save\d+\.txt$/i.test(name),
    );
    const entries = names.map((name) => ({
      original: path.join(this.saveDirectory, name),
      backup: path.join(backupDirectory, name),
    }));
    this.#plan = {
      createdAt: new Date().toISOString(),
      saveDirectory: this.saveDirectory,
      entries,
    };
    await this.#writePlan();
    for (const entry of entries) await rename(entry.original, entry.backup);
  }

  async restore(): Promise<void> {
    if (!this.#plan) return;
    const challengeDirectory = path.join(this.runDirectory, "challenge-save");
    await mkdir(challengeDirectory, { recursive: true });
    const challengeNames = (await readdir(this.saveDirectory)).filter((name) =>
      /^save\d+\.txt$/i.test(name),
    );
    for (const name of challengeNames) {
      await rename(
        path.join(this.saveDirectory, name),
        path.join(challengeDirectory, name),
      );
    }
    for (const entry of this.#plan.entries) {
      await copyFile(entry.backup, entry.original);
    }
    this.#plan.restoredAt = new Date().toISOString();
    await this.#writePlan();
  }

  async #writePlan(): Promise<void> {
    if (!this.#plan) return;
    await writeFile(this.recoveryPath, `${JSON.stringify(this.#plan, null, 2)}\n`);
  }
}

export async function restoreFromRecovery(recoveryPath: string): Promise<void> {
  const plan = JSON.parse(
    await (await import("node:fs/promises")).readFile(recoveryPath, "utf8"),
  ) as RecoveryPlan;
  for (const entry of plan.entries) {
    try {
      await stat(entry.original);
    } catch {
      await copyFile(entry.backup, entry.original);
    }
  }
  plan.restoredAt = new Date().toISOString();
  await writeFile(recoveryPath, `${JSON.stringify(plan, null, 2)}\n`);
}
