import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./command.js";
import {
  CheckpointStore,
  clearActiveRun,
  isTerminal,
  processMatches,
  readActiveRun,
} from "./run-checkpoint.js";

const SERVICE_NAME = "astra-parabox-watchdog.service";
const graphicalVariables = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "NIRI_SOCKET",
  "WAYLAND_DISPLAY",
  "XDG_CURRENT_DESKTOP",
  "XDG_RUNTIME_DIR",
] as const;

export async function runWatchdog(
  rootDirectory: string,
  options: { pollMs?: number; cliEntry?: string } = {},
): Promise<void> {
  const root = path.resolve(rootDirectory);
  const pollMs = Math.max(1_000, options.pollMs ?? 15_000);
  const cliEntry = path.resolve(
    options.cliEntry ?? path.join(root, "dist/src/cli.js"),
  );
  let stopping = false;
  let child: ChildProcess | null = null;
  const stop = () => {
    stopping = true;
    if (child?.exitCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    console.log(`Astra Parabox watchdog ready: ${root}`);
    while (!stopping) {
      const runDirectory = await readActiveRun(root);
      if (!runDirectory) {
        await delay(pollMs);
        continue;
      }

      let store: CheckpointStore;
      try {
        store = await CheckpointStore.load(runDirectory);
      } catch (error) {
        console.error(`Cannot read active checkpoint: ${String(error)}`);
        await delay(pollMs);
        continue;
      }
      let checkpoint = store.snapshot();
      if (isTerminal(checkpoint.phase)) {
        await clearActiveRun(root, runDirectory);
        continue;
      }
      if (checkpoint.phase === "paused") {
        await delay(pollMs);
        continue;
      }
      if (
        (checkpoint.phase === "running" || checkpoint.phase === "starting") &&
        checkpoint.pid !== null &&
        processMatches(checkpoint.pid, checkpoint.pidStartTicks)
      ) {
        await delay(pollMs);
        continue;
      }
      if (checkpoint.phase === "running" || checkpoint.phase === "starting") {
        checkpoint = await store.update({
          phase: "waiting_retry",
          pid: null,
          pidStartTicks: null,
          retryAt: new Date().toISOString(),
          reason: "Watchdog recovered an interrupted runner",
        });
      }

      const retryTime = checkpoint.retryAt
        ? Date.parse(checkpoint.retryAt)
        : Date.now();
      if (Number.isFinite(retryTime) && retryTime > Date.now()) {
        await delay(Math.min(pollMs, retryTime - Date.now()));
        continue;
      }

      const environment = await graphicalEnvironment();
      if (!(await graphicalSessionReady(environment))) {
        await delay(pollMs);
        continue;
      }

      console.log(
        `Resuming ${checkpoint.runId}, attempt ${checkpoint.attempt + 1}`,
      );
      child = spawn(process.execPath, [cliEntry, "resume", runDirectory], {
        cwd: root,
        env: environment,
        stdio: "inherit",
      });
      await new Promise<void>((resolve) => {
        child?.once("exit", () => resolve());
        child?.once("error", () => resolve());
      });
      child = null;
      if (!stopping) await delay(1_000);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function installWatchdogService(
  rootDirectory: string,
): Promise<string> {
  const root = path.resolve(rootDirectory);
  const serviceDirectory = path.join(os.homedir(), ".config/systemd/user");
  const servicePath = path.join(serviceDirectory, SERVICE_NAME);
  const cliEntry = path.join(root, "dist/src/cli.js");
  await mkdir(serviceDirectory, { recursive: true });
  const unit = `[Unit]
Description=Astra Parabox resumable challenge watchdog
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${systemdPath(root)}
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(cliEntry)} daemon
Restart=always
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
  await writeFile(servicePath, unit, { mode: 0o644 });
  const presentVariables = graphicalVariables.filter(
    (name) => process.env[name] !== undefined,
  );
  if (presentVariables.length > 0) {
    await runCommand("systemctl", [
      "--user",
      "import-environment",
      ...presentVariables,
    ]);
  }
  await expectSystemctl(["daemon-reload"]);
  await expectSystemctl(["enable", "--now", SERVICE_NAME]);
  return servicePath;
}

export async function uninstallWatchdogService(): Promise<void> {
  await runCommand("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
  await rm(
    path.join(os.homedir(), ".config/systemd/user", SERVICE_NAME),
    { force: true },
  );
  await expectSystemctl(["daemon-reload"]);
}

export async function watchdogServiceStatus(): Promise<{
  service: string;
  active: boolean;
  enabled: boolean;
}> {
  const active = await runCommand("systemctl", [
    "--user",
    "is-active",
    SERVICE_NAME,
  ]);
  const enabled = await runCommand("systemctl", [
    "--user",
    "is-enabled",
    SERVICE_NAME,
  ]);
  return {
    service: SERVICE_NAME,
    active: active.code === 0,
    enabled: enabled.code === 0,
  };
}

async function graphicalEnvironment(): Promise<NodeJS.ProcessEnv> {
  const environment = { ...process.env };
  const result = await runCommand("systemctl", ["--user", "show-environment"]);
  if (result.code !== 0) return environment;
  for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    if (!graphicalVariables.includes(name as (typeof graphicalVariables)[number])) {
      continue;
    }
    environment[name] = line.slice(separator + 1);
  }
  if (!(await pathExists(environment.NIRI_SOCKET))) {
    const runtimeDirectory = environment.XDG_RUNTIME_DIR;
    if (runtimeDirectory) {
      const socket = (await readdir(runtimeDirectory).catch(() => []))
        .filter((name) => /^niri\..+\.\d+\.sock$/.test(name))
        .sort()
        .at(-1);
      if (socket) {
        environment.NIRI_SOCKET = path.join(runtimeDirectory, socket);
        const display = /^niri\.(.+)\.\d+\.sock$/.exec(socket)?.[1];
        if (display) environment.WAYLAND_DISPLAY = display;
      }
    }
  }
  return environment;
}

async function graphicalSessionReady(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!env.NIRI_SOCKET || !env.WAYLAND_DISPLAY) return false;
  const result = await runCommand("niri", ["msg", "version"], {
    env,
    timeoutMs: 3_000,
  });
  return result.code === 0;
}

async function pathExists(filename: string | undefined): Promise<boolean> {
  if (!filename) return false;
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

function systemdPath(value: string): string {
  return value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\x5c")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\x09");
}

async function expectSystemctl(args: string[]): Promise<void> {
  const result = await runCommand("systemctl", ["--user", ...args]);
  if (result.code !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || "systemctl failed");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}
