# Recording and release checklist

## Before the take

1. Close Steam completely and disable Steam Cloud for app 1260520. The runner refuses to start if Steam is already running, because its single-instance forwarding could target the physical desktop.
2. Verify no separate screen recorder is capturing the physical desktop; the arena itself uses only private virtual displays.
3. Run `npm run doctor` and require every required check to pass.
4. Run `node dist/src/cli.js smoke-model`; do not start a formal run unless it succeeds.
5. Run `node dist/src/cli.js smoke-headless` once to verify the hidden game, keyboard, dashboard, and 1920×1080 recorder path. This does not use model tokens or alter save progress.
6. Run `node dist/src/cli.js service install` and confirm the watchdog is active.
7. Ensure enough free space for long 30 FPS Matroska recording parts and connect stable power/network. The model API needs network. Native search/browser access and shell network are disabled; any alternate external-information lookup invalidates the run.

## During the take

The runner opens the native game inside Gamescope's headless backend and the compact director dashboard inside Xvfb, then FFmpeg captures and combines only those two private X displays. It opens nothing on niri or any other physical compositor by default. The controller logs a loopback dashboard URL that the operator may open manually; `--browser` is the explicit opt-in to open it automatically. Do not interact after the timer starts. Infrastructure recovery is allowed only through the recorded watchdog path; human gameplay makes the run invalid.

The director dashboard shows:

- exact wall-clock elapsed time;
- Codex-reported cumulative tokens and their breakdown;
- referee progress for viewers only;
- model/status and the no-search badge; and
- sanitized live reasoning summaries and MCP tool calls.

The dashboard does not send commands and is not visible to the model.

## After the take

1. Confirm `summary.json` says `completed`, `364/364`, and `savesRestored: true`; disclose its `continuous` or `resumed` classification.
2. Run the test suite again at the exact commit used for the challenge.
3. Verify `manifest.sha256.json` against the artifacts.
4. Concatenate the ordered `recordings/challenge-part-*.mkv` files, then transcode the result to the platform delivery format; retain every original part.
5. Put the repository commit SHA, model, effort, Codex version, timer, token breakdown, prompt, and artifact manifest hash in the video description.
6. Review raw logs, save files, browser profile, and frames before publishing. Do not upload credentials, local paths that reveal private information, or proprietary game data beyond footage permitted by the rights holder/platform.

Recommended video framing is 2560×1440 or 1920×1080, with the game using roughly two thirds of the width. Preserve legible token/time figures at the final delivery resolution.
