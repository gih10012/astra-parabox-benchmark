export const TARGET_LEVELS = 364;

export type ChallengeStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface LevelProgress {
  total: number;
  unlocked: number;
  completed: number;
}

export interface TimeSnapshot {
  status: ChallengeStatus;
  elapsedMs: number;
  startedAt: string | null;
  endedAt: string | null;
  sampledAt: string;
}

export interface TokenSnapshot extends TokenUsage {
  sampledAt: string;
  source: "none" | "rollout" | "exec";
}

export interface ChallengeSnapshot {
  runId: string | null;
  model: string;
  status: ChallengeStatus;
  targetLevels: number;
  progress: LevelProgress;
  time: TimeSnapshot;
  tokens: TokenSnapshot;
  failure: string | null;
}

export interface GameFrame {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width?: number;
  height?: number;
  sha256: string;
  capturedAt: string;
}

export const allowedKeys = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "Z",
  "R",
  "ENTER",
  "ESCAPE",
  "SPACE",
] as const;

export type AllowedKey = (typeof allowedKeys)[number];

export interface GameAdapter {
  discover(): Promise<{ windowId: number; title: string }>;
  capture(): Promise<GameFrame>;
  press(
    keys: AllowedKey[],
    options: { intervalMs: number; settleMs: number },
  ): Promise<void>;
  close?(): Promise<void>;
}
