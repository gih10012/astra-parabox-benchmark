import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expectCommand } from "./command.js";
import {
  type AllowedKey,
  type GameAdapter,
  type GameFrame,
} from "./types.js";

const keyNames: Record<AllowedKey, string> = {
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
  Z: "z",
  R: "r",
  ENTER: "Return",
  ESCAPE: "Escape",
  SPACE: "space",
};

interface NiriWindow {
  id: number;
  title: string;
  app_id: string;
}

export class NiriGameAdapter implements GameAdapter {
  readonly frameDirectory: string;
  readonly titlePattern: RegExp;
  #window: NiriWindow | null = null;
  #captureCounter = 0;
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: { frameDirectory: string; titlePattern?: RegExp }) {
    this.frameDirectory = options.frameDirectory;
    this.titlePattern = options.titlePattern ?? /Patrick'?s Parabox/i;
  }

  async discover(): Promise<{ windowId: number; title: string }> {
    const stdout = await expectCommand("niri", ["msg", "--json", "windows"]);
    const windows = JSON.parse(stdout.toString("utf8")) as NiriWindow[];
    const match = windows.find(
      (window) =>
        this.titlePattern.test(window.title) ||
        this.titlePattern.test(window.app_id),
    );
    if (!match) throw new Error("Patrick's Parabox window not found");
    this.#window = match;
    return { windowId: match.id, title: match.title };
  }

  async capture(): Promise<GameFrame> {
    return await this.#exclusive(async () => {
      const window = this.#window ?? (await this.#discoverWindow());
      await mkdir(this.frameDirectory, { recursive: true });
      const number = String(++this.#captureCounter).padStart(8, "0");
      const pngPath = path.join(this.frameDirectory, `${number}.png`);
      const jpegPath = path.join(this.frameDirectory, `${number}.jpg`);
      await expectCommand("niri", [
        "msg",
        "action",
        "screenshot-window",
        "--id",
        String(window.id),
        "--write-to-disk",
        "true",
        "--show-pointer",
        "false",
        "--path",
        pngPath,
      ]);
      await expectCommand("ffmpeg", [
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        pngPath,
        "-vf",
        "scale='min(1280,iw)':-2",
        "-frames:v",
        "1",
        "-q:v",
        "3",
        jpegPath,
      ]);
      const data = await readFile(jpegPath);
      await rm(pngPath, { force: true });
      return {
        data,
        mimeType: "image/jpeg",
        sha256: createHash("sha256").update(data).digest("hex"),
        capturedAt: new Date().toISOString(),
      };
    });
  }

  async press(
    keys: AllowedKey[],
    options: { intervalMs: number; settleMs: number },
  ): Promise<void> {
    await this.#exclusive(async () => {
      const window = this.#window ?? (await this.#discoverWindow());
      await expectCommand("niri", [
        "msg",
        "action",
        "focus-window",
        "--id",
        String(window.id),
      ]);
      const args: string[] = [];
      keys.forEach((key, index) => {
        if (index > 0 && options.intervalMs > 0) {
          args.push("-s", String(options.intervalMs));
        }
        args.push("-k", keyNames[key]);
      });
      await expectCommand("wtype", args, {
        timeoutMs: Math.max(15_000, keys.length * options.intervalMs + 5_000),
      });
      if (options.settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.settleMs));
      }
    });
  }

  async close(): Promise<void> {
    if (!this.#window) return;
    await expectCommand("niri", [
      "msg",
      "action",
      "close-window",
      "--id",
      String(this.#window.id),
    ]);
    this.#window = null;
  }

  async #discoverWindow(): Promise<NiriWindow> {
    await this.discover();
    if (!this.#window) throw new Error("Game window discovery failed");
    return this.#window;
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(operation, operation);
    this.#serial = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export class MockGameAdapter implements GameAdapter {
  presses: AllowedKey[][] = [];

  async discover() {
    return { windowId: 1, title: "Patrick's Parabox (mock)" };
  }

  async capture(): Promise<GameFrame> {
    return {
      data: pixel,
      mimeType: "image/png",
      width: 1,
      height: 1,
      sha256: createHash("sha256").update(pixel).digest("hex"),
      capturedAt: new Date().toISOString(),
    };
  }

  async press(
    keys: AllowedKey[],
    _options: { intervalMs: number; settleMs: number },
  ): Promise<void> {
    this.presses.push([...keys]);
  }

  async close(): Promise<void> {}
}
