import { access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexEnvironment,
  displayCodexHome,
  resolveCodexHome,
} from "./codex-home.js";
import { runCommand } from "./command.js";
import { parseParaboxSave } from "./save-parser.js";
import { TARGET_LEVELS } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export function defaultGamePaths() {
  const steam = path.join(os.homedir(), ".local/share/Steam");
  const libraryRoots = [
    steam,
    "/share/SteamLibrary",
    "/windows/Program Files (x86)/Steam",
  ];
  const library =
    libraryRoots.find((root) =>
      existsSync(path.join(root, "steamapps/appmanifest_1260520.acf")),
    ) ?? steam;
  return {
    manifest: path.join(library, "steamapps/appmanifest_1260520.acf"),
    executable: path.join(
      library,
      "steamapps/common/Patrick's Parabox/Patrick's Parabox.exe",
    ),
    saveDirectory: path.join(
      steam,
      "steamapps/compatdata/1260520/pfx/drive_c/users/steamuser/AppData/LocalLow/Patrick Traynor/Patrick's Parabox",
    ),
  };
}

async function commandCheck(command: string, required = true): Promise<DoctorCheck> {
  const result = await runCommand("which", [command]);
  return {
    name: command,
    ok: result.code === 0,
    detail:
      result.code === 0 ? result.stdout.toString("utf8").trim() : "not found",
    required,
  };
}

async function fileCheck(
  name: string,
  filename: string,
  required = true,
): Promise<DoctorCheck> {
  try {
    await access(filename);
    return { name, ok: true, detail: filename, required };
  } catch {
    return { name, ok: false, detail: `missing: ${filename}`, required };
  }
}

export async function runDoctor(options: { codexHome?: string } = {}): Promise<DoctorCheck[]> {
  const paths = defaultGamePaths();
  const codexHome = await resolveCodexHome(options.codexHome);
  const codexEnv = codexEnvironment(codexHome);
  const checks = await Promise.all([
    commandCheck("node"),
    commandCheck("codex"),
    commandCheck("niri"),
    commandCheck("wtype"),
    commandCheck("ffmpeg"),
    commandCheck("wf-recorder"),
    commandCheck("google-chrome-stable", false),
    commandCheck("steam"),
    fileCheck("Patrick's Parabox manifest", paths.manifest),
    fileCheck("Patrick's Parabox executable", paths.executable),
    fileCheck("Patrick's Parabox save directory", paths.saveDirectory),
  ]);

  const loginResult = await runCommand("codex", ["login", "status"], {
    env: codexEnv,
  });
  checks.push({
    name: "Codex credentials",
    ok: loginResult.code === 0,
    detail:
      loginResult.code === 0
        ? `authenticated via ${displayCodexHome(codexHome)}`
        : `not authenticated via ${displayCodexHome(codexHome)}`,
    required: true,
  });

  const modelResult = await runCommand("codex", ["debug", "models", "--bundled"], {
    env: codexEnv,
  });
  let modelOk = false;
  if (modelResult.code === 0) {
    try {
      const text = modelResult.stdout.toString("utf8");
      modelOk = text.includes('"gpt-6-astra"');
    } catch {
      modelOk = false;
    }
  }
  checks.push({
    name: "gpt-6-astra model",
    ok: modelOk,
    detail: modelOk ? "present in bundled Codex catalog" : "not in model catalog",
    required: true,
  });

  const saveNames = ["save0.txt", "save1.txt", "save2.txt"];
  let detectedTotal = 0;
  for (const name of saveNames) {
    try {
      const progress = parseParaboxSave(
        await readFile(path.join(paths.saveDirectory, name), "utf8"),
      );
      detectedTotal = Math.max(detectedTotal, progress.total);
    } catch {
      // A missing slot is normal.
    }
  }
  checks.push({
    name: "official level catalog",
    ok: detectedTotal === TARGET_LEVELS,
    detail: `${detectedTotal}/${TARGET_LEVELS} entries detected in local save format`,
    required: true,
  });

  const niri = await runCommand("niri", ["msg", "version"]);
  checks.push({
    name: "niri IPC",
    ok: niri.code === 0,
    detail:
      niri.code === 0
        ? niri.stdout.toString("utf8").split("\n")[0] ?? "available"
        : niri.stderr.toString("utf8").trim(),
    required: true,
  });
  return checks;
}
