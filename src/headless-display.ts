import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.js";

const GAME_WIDTH = 1280;
const VIDEO_HEIGHT = 1080;
const DASHBOARD_WIDTH = 640;
const CHROME_APP_INSET = 8;

export interface VirtualGameRuntime {
  display: string;
  gamescopeDisplay: string;
  keypressCommand: string;
  compositorScreenshot: {
    command: string;
    environment: NodeJS.ProcessEnv;
  };
  close(): Promise<void>;
}

export interface VirtualDashboardRuntime {
  display: string;
  close(): Promise<void>;
}

export type VirtualGameMirrorRuntime = VirtualDashboardRuntime;

export async function startVirtualGame(options: {
  rootDirectory: string;
  runtimeDirectory: string;
  executable: string;
}): Promise<VirtualGameRuntime> {
  const gamescope = await resolveTool(
    "gamescope",
    process.env.ASTRA_GAMESCOPE,
    path.join(options.rootDirectory, ".arena/tools/gamescope-root/usr/bin/gamescope"),
  );
  const gamescopeCtl = path.join(path.dirname(gamescope), "gamescopectl");
  await access(gamescopeCtl);
  const xvfb = await resolveTool(
    "Xvfb",
    process.env.ASTRA_XVFB,
    path.join(options.rootDirectory, ".arena/tools/xvfb-root/usr/bin/Xvfb"),
  );
  const proton = await resolveProton();
  const keypressCommand = await ensureKeypressHelper(options.rootDirectory);
  const environmentFile = path.join(options.runtimeDirectory, "headless-environment.json");
  const gamescopeLog = path.join(options.runtimeDirectory, "gamescope.log");
  const hostEntry = path.join(options.rootDirectory, "dist/src/headless-host.js");
  await access(hostEntry);

  const runtimeEnvironment = withoutPhysicalDisplay(process.env);
  runtimeEnvironment.PATH = `${path.dirname(gamescope)}:${runtimeEnvironment.PATH ?? ""}`;
  const privateLibrary = path.resolve(
    options.rootDirectory,
    ".arena/tools/gamescope-root/usr/lib",
  );
  if (existsSync(privateLibrary)) {
    runtimeEnvironment.LD_LIBRARY_PATH = [
      privateLibrary,
      runtimeEnvironment.LD_LIBRARY_PATH,
    ].filter(Boolean).join(":");
  }
  const privateData = path.resolve(
    options.rootDirectory,
    ".arena/tools/gamescope-root/usr/share",
  );
  if (existsSync(privateData)) {
    runtimeEnvironment.XDG_DATA_DIRS = [
      privateData,
      runtimeEnvironment.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share",
    ].join(":");
  }

  const gamescopeProcess = spawn(
    gamescope,
    [
      "--backend", "headless",
      "-W", String(GAME_WIDTH),
      "-H", String(VIDEO_HEIGHT),
      "-w", String(GAME_WIDTH),
      "-h", String(VIDEO_HEIGHT),
      "-r", "30",
      "--force-windows-fullscreen",
      "--expose-wayland",
      "--keep-alive",
      "--",
      process.execPath,
      hostEntry,
      environmentFile,
    ],
    {
      cwd: options.rootDirectory,
      env: runtimeEnvironment,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  gamescopeProcess.stderr?.pipe(createWriteStream(gamescopeLog, { flags: "a" }));
  const childProcesses: ChildProcess[] = [gamescopeProcess];

  try {
    const hostEnvironment = await waitForJsonEnvironment(
      environmentFile,
      gamescopeProcess,
      30_000,
    );
    const display = hostEnvironment.DISPLAY;
    const gamescopeDisplay = hostEnvironment.GAMESCOPE_WAYLAND_DISPLAY;
    if (!display || !gamescopeDisplay) {
      throw new Error("Gamescope did not report its private displays");
    }
    const childEnvironment = {
      ...runtimeEnvironment,
      ...hostEnvironment,
    };

    if (await steamIsRunning()) {
      throw new Error(
        "Steam is already running. Close it before a headless challenge so it cannot forward the game to the physical desktop.",
      );
    }
    const steamDisplay = await freeXDisplay(170, 199);
    const steamXvfbProcess = spawn(
      xvfb,
      [steamDisplay, "-screen", "0", "1024x768x24", "-br", "-nolisten", "tcp", "-noreset"],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    logChildOutput(
      steamXvfbProcess,
      path.join(options.runtimeDirectory, "steam-xvfb.log"),
    );
    childProcesses.push(steamXvfbProcess);
    await waitForXDisplay(steamDisplay, steamXvfbProcess, 15_000);
    const steamEnvironment: NodeJS.ProcessEnv = {
      ...childEnvironment,
      DISPLAY: steamDisplay,
    };
    delete steamEnvironment.WAYLAND_DISPLAY;
    delete steamEnvironment.GAMESCOPE_WAYLAND_DISPLAY;
    const steamProcess = spawn("steam", [
      "-inhibitbootstrap",
      "-skipinitialbootstrap",
      "-nobootstrapperupdate",
      "-noverifyfiles",
      "-silent",
    ], {
      env: steamEnvironment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    logChildOutput(steamProcess, path.join(options.runtimeDirectory, "steam.log"));
    childProcesses.push(steamProcess);
    await waitForSteamReady(steamProcess, 30 * 60_000);

    const steamRoot = path.join(process.env.HOME ?? "", ".local/share/Steam");
    const gameProcess = spawn(
      proton,
      [
        "run",
        options.executable,
        "-screen-fullscreen", "0",
        "-screen-width", String(GAME_WIDTH),
        "-screen-height", String(VIDEO_HEIGHT),
      ],
      {
        env: {
          ...childEnvironment,
          STEAM_COMPAT_DATA_PATH: path.join(steamRoot, "steamapps/compatdata/1260520"),
          STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot,
          SteamAppId: "1260520",
          SteamGameId: "1260520",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    logChildOutput(gameProcess, path.join(options.runtimeDirectory, "game.log"));
    childProcesses.push(gameProcess);

    return {
      display,
      gamescopeDisplay,
      keypressCommand,
      compositorScreenshot: {
        command: gamescopeCtl,
        environment: childEnvironment,
      },
      close: async () => {
        stopProcessGroup(gameProcess, "SIGTERM");
        await delay(500);
        await runCommand("steam", ["-shutdown"], {
          env: steamEnvironment,
          timeoutMs: 5_000,
        }).catch(() => undefined);
        stopProcessGroup(steamProcess, "SIGTERM");
        await runCommand(gamescopeCtl, ["shutdown"], {
          env: childEnvironment,
          timeoutMs: 3_000,
        }).catch(() => undefined);
        stopProcessGroup(gamescopeProcess, "SIGTERM");
        await delay(1_000);
        for (const child of childProcesses) stopProcessGroup(child, "SIGKILL");
      },
    };
  } catch (error) {
    for (const child of childProcesses) stopProcessGroup(child, "SIGKILL");
    throw error;
  }
}

export async function startVirtualDashboard(options: {
  rootDirectory: string;
  runtimeDirectory: string;
  url: string;
}): Promise<VirtualDashboardRuntime> {
  const xvfb = await resolveTool(
    "Xvfb",
    process.env.ASTRA_XVFB,
    path.join(options.rootDirectory, ".arena/tools/xvfb-root/usr/bin/Xvfb"),
  );
  const display = await freeXDisplay(90, 129);
  const xvfbProcess = spawn(
    xvfb,
    [display, "-screen", "0", `${DASHBOARD_WIDTH}x${VIDEO_HEIGHT}x24`, "-nolisten", "tcp", "-noreset"],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  logChildOutput(xvfbProcess, path.join(options.runtimeDirectory, "xvfb.log"));
  try {
    await waitForXDisplay(display, xvfbProcess, 15_000);
    const chromeEnvironment = withoutPhysicalDisplay(process.env);
    chromeEnvironment.DISPLAY = display;
    chromeEnvironment.XDG_SESSION_TYPE = "x11";
    chromeEnvironment.LANGUAGE = "en_US:en";
    chromeEnvironment.LANG = "en_US.UTF-8";
    const chromeProcess = spawn(
      "google-chrome-stable",
      [
        "--ozone-platform=x11",
        `--user-data-dir=${path.join(options.runtimeDirectory, "dashboard-chrome-profile")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--disable-component-update",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--hide-scrollbars",
        "--disable-sync",
        "--disable-translate",
        "--disable-features=Translate,TranslateUI,OptimizationHints,MediaRouter,PushMessaging",
        "--lang=en-US",
        "--accept-lang=en-US",
        "--window-position=0,0",
        `--window-size=${DASHBOARD_WIDTH},${VIDEO_HEIGHT}`,
        `--app=${options.url}/?compact=1`,
      ],
      {
        env: chromeEnvironment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    logChildOutput(
      chromeProcess,
      path.join(options.runtimeDirectory, "dashboard-chrome.log"),
    );
    await delay(3_000);
    if (chromeProcess.exitCode !== null) {
      throw new Error("Hidden director Chrome exited before recording");
    }
    return {
      display,
      close: async () => {
        stopProcessGroup(chromeProcess, "SIGTERM");
        stopProcessGroup(xvfbProcess, "SIGTERM");
        await delay(500);
        stopProcessGroup(chromeProcess, "SIGKILL");
        stopProcessGroup(xvfbProcess, "SIGKILL");
      },
    };
  } catch (error) {
    stopProcessGroup(xvfbProcess, "SIGKILL");
    throw error;
  }
}

export async function startVirtualGameMirror(options: {
  rootDirectory: string;
  runtimeDirectory: string;
  url: string;
}): Promise<VirtualGameMirrorRuntime> {
  const xvfb = await resolveTool(
    "Xvfb",
    process.env.ASTRA_XVFB,
    path.join(options.rootDirectory, ".arena/tools/xvfb-root/usr/bin/Xvfb"),
  );
  const display = await freeXDisplay(130, 169);
  const xvfbProcess = spawn(
    xvfb,
    [display, "-screen", "0", `${GAME_WIDTH}x${VIDEO_HEIGHT}x24`, "-br", "-nolisten", "tcp", "-noreset"],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  logChildOutput(xvfbProcess, path.join(options.runtimeDirectory, "game-mirror-xvfb.log"));
  try {
    await waitForXDisplay(display, xvfbProcess, 15_000);
    const environment = withoutPhysicalDisplay(process.env);
    environment.DISPLAY = display;
    environment.XDG_SESSION_TYPE = "x11";
    environment.LANG = "en_US.UTF-8";
    const chromeProcess = spawn(
      "google-chrome-stable",
      [
        "--ozone-platform=x11",
        `--user-data-dir=${path.join(options.runtimeDirectory, "game-mirror-chrome-profile")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--disable-component-update",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--hide-scrollbars",
        "--disable-sync",
        "--disable-translate",
        "--disable-features=Translate,TranslateUI,OptimizationHints,MediaRouter,PushMessaging",
        "--window-position=0,0",
        `--window-size=${GAME_WIDTH},${VIDEO_HEIGHT}`,
        `--app=${options.url}/game.html`,
      ],
      { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    logChildOutput(
      chromeProcess,
      path.join(options.runtimeDirectory, "game-mirror-chrome.log"),
    );
    await delay(2_000);
    if (chromeProcess.exitCode !== null) throw new Error("Hidden game mirror exited early");
    return {
      display,
      close: async () => {
        stopProcessGroup(chromeProcess, "SIGTERM");
        stopProcessGroup(xvfbProcess, "SIGTERM");
        await delay(500);
        stopProcessGroup(chromeProcess, "SIGKILL");
        stopProcessGroup(xvfbProcess, "SIGKILL");
      },
    };
  } catch (error) {
    stopProcessGroup(xvfbProcess, "SIGKILL");
    throw error;
  }
}

export function hiddenRecorderArguments(options: {
  gameDisplay: string;
  dashboardDisplay: string;
  output: string;
}): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "warning",
    "-y",
    "-thread_queue_size", "512",
    "-f", "x11grab",
    "-draw_mouse", "0",
    "-framerate", "30",
    "-video_size", `${GAME_WIDTH}x${VIDEO_HEIGHT}`,
    "-i", `${options.gameDisplay}.0`,
    "-thread_queue_size", "512",
    "-f", "x11grab",
    "-draw_mouse", "0",
    "-framerate", "30",
    "-video_size", `${DASHBOARD_WIDTH}x${VIDEO_HEIGHT}`,
    "-i", `${options.dashboardDisplay}.0`,
    "-filter_complex",
    `[0:v]crop=${GAME_WIDTH - CHROME_APP_INSET}:${VIDEO_HEIGHT - CHROME_APP_INSET}:${CHROME_APP_INSET}:${CHROME_APP_INSET},scale=${GAME_WIDTH}:${VIDEO_HEIGHT}:flags=lanczos,setsar=1,setpts=N/(30*TB)[g];[1:v]scale=${DASHBOARD_WIDTH}:${VIDEO_HEIGHT}:flags=lanczos,setsar=1,setpts=N/(30*TB)[d];[g][d]hstack=inputs=2:shortest=1,fps=30,setpts=N/(30*TB)[v]`,
    "-map", "[v]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-fps_mode", "cfr",
    "-f", "matroska",
    options.output,
  ];
}

async function ensureKeypressHelper(rootDirectory: string): Promise<string> {
  const output = path.join(rootDirectory, ".arena/bin/astra-x11-keypress");
  const source = path.join(rootDirectory, "native/x11-keypress.c");
  await mkdir(path.dirname(output), { recursive: true });
  let rebuild = true;
  try {
    rebuild = (await stat(output)).mtimeMs < (await stat(source)).mtimeMs;
  } catch {
    rebuild = true;
  }
  if (rebuild) {
    const result = await runCommand(
      "cc",
      ["-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output, "-lX11", "-lXtst"],
      { timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      throw new Error(`Cannot build X11 key helper: ${result.stderr.toString("utf8").trim()}`);
    }
  }
  return output;
}

async function waitForSteamReady(
  steamProcess: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (steamProcess.exitCode !== null) {
      throw new Error(`Steam exited before becoming ready (${steamProcess.exitCode})`);
    }
    const webHelper = await runCommand("pgrep", ["-f", "/steamwebhelper"]);
    if (webHelper.code === 0) return;
    await delay(1_000);
  }
  throw new Error("Steam did not become ready within 30 minutes");
}

async function resolveTool(
  command: string,
  override: string | undefined,
  localFallback: string,
): Promise<string> {
  if (override) {
    await access(override);
    return path.resolve(override);
  }
  const result = await runCommand("which", [command]);
  if (result.code === 0) return result.stdout.toString("utf8").trim();
  await access(localFallback);
  return localFallback;
}

async function resolveProton(): Promise<string> {
  const override = process.env.ASTRA_PROTON;
  if (override) {
    await access(override);
    return path.resolve(override);
  }
  const steamRoot = path.join(process.env.HOME ?? "", ".local/share/Steam");
  const roots = [
    path.join(steamRoot, "compatibilitytools.d"),
    path.join(steamRoot, "steamapps/common"),
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/proton/i.test(entry.name)) continue;
      const executable = path.join(root, entry.name, "proton");
      if (existsSync(executable)) candidates.push(executable);
    }
  }
  candidates.sort((left, right) => protonRank(right) - protonRank(left));
  if (!candidates[0]) throw new Error("No Proton launcher found; set ASTRA_PROTON");
  return candidates[0];
}

function protonRank(filename: string): number {
  if (/experimental.*ext4/i.test(filename)) return 30;
  if (/experimental/i.test(filename)) return 20;
  return 10;
}

async function waitForJsonEnvironment(
  filename: string,
  process: ChildProcess,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("Gamescope exited before it was ready");
    try {
      return JSON.parse(await readFile(filename, "utf8")) as Record<string, string>;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Gamescope startup timed out");
}

async function waitForXDisplay(
  display: string,
  process: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("Xvfb exited before it was ready");
    const result = await runCommand("xprop", ["-display", display, "-root"], {
      timeoutMs: 1_000,
    });
    if (result.code === 0) return;
    await delay(100);
  }
  throw new Error("Xvfb startup timed out");
}

async function freeXDisplay(first: number, last: number): Promise<string> {
  for (let number = first; number <= last; number++) {
    if (!existsSync(`/tmp/.X11-unix/X${number}`)) return `:${number}`;
  }
  throw new Error(`No free X display between :${first} and :${last}`);
}

async function steamIsRunning(): Promise<boolean> {
  const result = await runCommand("pgrep", ["-x", "steam"]);
  return result.code === 0;
}

function withoutPhysicalDisplay(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  delete environment.DISPLAY;
  delete environment.WAYLAND_DISPLAY;
  delete environment.NIRI_SOCKET;
  delete environment.XDG_CURRENT_DESKTOP;
  return environment;
}

function stopProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process has already exited.
    }
  }
  // Proton descendants can outlive the launcher while retaining its inherited
  // stdout/stderr pipes.  Detach those pipes during teardown so a finished
  // runner cannot keep the watchdog blocked waiting for Node's event loop.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function logChildOutput(child: ChildProcess, filename: string): void {
  const output = createWriteStream(filename, { flags: "a" });
  child.stdout?.on("data", (chunk: Buffer) => output.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.write(chunk));
  child.once("close", () => output.end());
  child.once("error", () => output.end());
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
