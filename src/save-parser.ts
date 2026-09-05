import type { LevelProgress } from "./types.js";

const levelLine = /^\S+\s+([01])\s+([01])\s*$/;

export function parseParaboxSave(text: string): LevelProgress {
  let inLevels = false;
  let total = 0;
  let unlocked = 0;
  let completed = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "-section levels") {
      inLevels = true;
      continue;
    }
    if (line.startsWith("-section ")) {
      inLevels = false;
      continue;
    }
    if (!inLevels || line.length === 0) continue;
    const match = levelLine.exec(line);
    if (!match) continue;
    total += 1;
    unlocked += Number(match[1]);
    completed += Number(match[2]);
  }

  return { total, unlocked, completed };
}
