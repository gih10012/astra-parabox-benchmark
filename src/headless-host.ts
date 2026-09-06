#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const output = process.argv[2];
if (!output) throw new Error("headless-host requires an environment output path");

const values = {
  DISPLAY: process.env.DISPLAY,
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
  GAMESCOPE_WAYLAND_DISPLAY: process.env.GAMESCOPE_WAYLAND_DISPLAY,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
};
if (!values.DISPLAY || !values.GAMESCOPE_WAYLAND_DISPLAY) {
  throw new Error("headless-host was not launched by Gamescope");
}
await writeFile(output, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });

const keepAlive = setInterval(() => undefined, 60_000);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
clearInterval(keepAlive);
