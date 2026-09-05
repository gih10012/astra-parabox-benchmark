import { EventEmitter } from "node:events";
import {
  emptyTokenUsage,
  extractTokenUsage,
  mergeUsage,
} from "./codex-events.js";
import { parseParaboxSave } from "./save-parser.js";
import {
  TARGET_LEVELS,
  type ChallengeSnapshot,
  type ChallengeStatus,
  type LevelProgress,
  type TokenSnapshot,
  type TokenUsage,
} from "./types.js";

export class ChallengeState extends EventEmitter {
  readonly model: string;
  readonly targetLevels: number;
  readonly attempt: number;
  #runId: string | null = null;
  #status: ChallengeStatus = "idle";
  #startedAtWall: number | null = null;
  #startedAtMono: bigint | null = null;
  #elapsedBeforeMs = 0;
  #endedAtWall: number | null = null;
  #endedAtMono: bigint | null = null;
  #usage: TokenUsage = emptyTokenUsage();
  #tokenSource: TokenSnapshot["source"] = "none";
  #progress: LevelProgress = { total: 0, unlocked: 0, completed: 0 };
  #failure: string | null = null;

  constructor(model = "gpt-6-astra", targetLevels = TARGET_LEVELS, attempt = 1) {
    super();
    this.model = model;
    this.targetLevels = targetLevels;
    this.attempt = attempt;
  }

  start(
    runId: string,
    nowWall = Date.now(),
    nowMono = process.hrtime.bigint(),
    resume?: {
      elapsedMs: number;
      startedAt: string | null;
      tokens: TokenUsage;
      progress: LevelProgress;
    },
  ): void {
    if (this.#status !== "idle") throw new Error("Challenge already started");
    this.#runId = runId;
    this.#status = "running";
    this.#startedAtWall = resume?.startedAt
      ? Date.parse(resume.startedAt)
      : nowWall;
    this.#startedAtMono = nowMono;
    this.#elapsedBeforeMs = Math.max(0, resume?.elapsedMs ?? 0);
    if (resume) {
      this.#usage = { ...resume.tokens };
      this.#progress = { ...resume.progress };
    }
    this.emit("change", this.snapshot());
  }

  ingestCodexEvent(event: unknown): void {
    const extracted = extractTokenUsage(event);
    if (!extracted) return;
    const merged = mergeUsage(this.#usage, extracted.usage);
    if (merged === this.#usage) return;
    this.#usage = merged;
    this.#tokenSource = extracted.source;
    this.emit("change", this.snapshot());
  }

  ingestSave(text: string): LevelProgress {
    this.#progress = parseParaboxSave(text);
    if (
      this.#status === "running" &&
      this.#progress.total === this.targetLevels &&
      this.#progress.completed === this.targetLevels
    ) {
      this.finish("completed");
    } else {
      this.emit("change", this.snapshot());
    }
    return this.#progress;
  }

  fail(message: string): void {
    this.#failure = message;
    if (this.#status === "idle") {
      this.#status = "failed";
      this.#endedAtWall = Date.now();
      this.#endedAtMono = process.hrtime.bigint();
      this.emit("change", this.snapshot());
      this.emit("finished", this.snapshot());
      return;
    }
    this.finish("failed");
  }

  stop(): void {
    this.finish("stopped");
  }

  finish(status: Exclude<ChallengeStatus, "idle" | "running">): void {
    if (this.#status !== "running") return;
    this.#status = status;
    this.#endedAtWall = Date.now();
    this.#endedAtMono = process.hrtime.bigint();
    this.emit("change", this.snapshot());
    this.emit("finished", this.snapshot());
  }

  timeSnapshot(nowWall = Date.now(), nowMono = process.hrtime.bigint()) {
    const elapsedMs =
      this.#startedAtMono === null
        ? this.#elapsedBeforeMs
        : this.#elapsedBeforeMs +
          Number((this.#endedAtMono ?? nowMono) - this.#startedAtMono) /
            1_000_000;
    return {
      status: this.#status,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      startedAt:
        this.#startedAtWall === null
          ? null
          : new Date(this.#startedAtWall).toISOString(),
      endedAt:
        this.#endedAtWall === null
          ? null
          : new Date(this.#endedAtWall).toISOString(),
      sampledAt: new Date(nowWall).toISOString(),
    };
  }

  tokenSnapshot(): TokenSnapshot {
    return {
      ...this.#usage,
      source: this.#tokenSource,
      sampledAt: new Date().toISOString(),
    };
  }

  snapshot(): ChallengeSnapshot {
    return {
      runId: this.#runId,
      model: this.model,
      attempt: this.attempt,
      status: this.#status,
      targetLevels: this.targetLevels,
      progress: { ...this.#progress },
      time: this.timeSnapshot(),
      tokens: this.tokenSnapshot(),
      failure: this.#failure,
    };
  }
}
