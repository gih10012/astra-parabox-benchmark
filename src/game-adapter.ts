import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expectCommand, runCommand } from "./command.js";
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

const X11_KEY_HOLD_MS = 80;

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

export class X11GameAdapter implements GameAdapter {
  readonly display: string;
  readonly frameDirectory: string;
  readonly keypressCommand: string;
  readonly titlePattern: RegExp;
  #window: NiriWindow | null = null;
  #captureCounter = 0;
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: {
    display: string;
    frameDirectory: string;
    keypressCommand: string;
    titlePattern?: RegExp;
  }) {
    this.display = options.display;
    this.frameDirectory = options.frameDirectory;
    this.keypressCommand = options.keypressCommand;
    this.titlePattern = options.titlePattern ?? /Patrick'?s Parabox|steam_app_1260520/i;
  }

  async discover(): Promise<{ windowId: number; title: string }> {
    const root = await expectCommand("xprop", [
      "-display",
      this.display,
      "-root",
      "GAMESCOPE_FOCUSABLE_WINDOWS",
      "GAMESCOPE_FOCUSED_WINDOW",
    ]);
    const ids = [...new Set(
      [...root.toString("utf8").matchAll(/\b\d{4,}\b/g)].map((match) =>
        Number(match[0]),
      ),
    )].filter((id) => Number.isSafeInteger(id) && id > 0);
    for (const id of ids) {
      const result = await runCommand("xprop", [
        "-display",
        this.display,
        "-id",
        String(id),
        "WM_NAME",
        "_NET_WM_NAME",
        "WM_CLASS",
      ]);
      if (result.code !== 0) continue;
      const properties = result.stdout.toString("utf8");
      if (!this.titlePattern.test(properties)) continue;
      const title =
        /(?:_NET_WM_NAME|WM_NAME)[^(]*\([^)]*\)\s*=\s*"([^"]+)"/.exec(
          properties,
        )?.[1] ?? "Patrick's Parabox";
      this.#window = { id, title, app_id: "steam_app_1260520" };
      return { windowId: id, title };
    }
    throw new Error("Patrick's Parabox window not found on the private X display");
  }

  async capture(): Promise<GameFrame> {
    return await this.#exclusive(async () => {
      const window = this.#window ?? (await this.#discoverWindow());
      await mkdir(this.frameDirectory, { recursive: true });
      const number = String(++this.#captureCounter).padStart(8, "0");
      const jpegPath = path.join(this.frameDirectory, `${number}.jpg`);
      await expectCommand("ffmpeg", [
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "x11grab",
        "-draw_mouse",
        "0",
        "-framerate",
        "30",
        "-window_id",
        String(window.id),
        "-i",
        `${this.display}.0`,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1280,iw)':-2",
        "-q:v",
        "3",
        jpegPath,
      ], { timeoutMs: 10_000 });
      const data = await readFile(jpegPath);
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
      await expectCommand(
        this.keypressCommand,
        [
          this.display,
          String(window.id),
          String(options.intervalMs),
          String(options.settleMs),
          String(X11_KEY_HOLD_MS),
          ...keys.map((key) => keyNames[key]),
        ],
        {
          timeoutMs: Math.max(
            15_000,
            keys.length * (options.intervalMs + X11_KEY_HOLD_MS) +
              options.settleMs +
              5_000,
          ),
        },
      );
    });
  }

  async close(): Promise<void> {
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
