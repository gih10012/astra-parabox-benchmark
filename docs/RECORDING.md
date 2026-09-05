# Recording and release checklist

## Before the take

1. Close Patrick's Parabox and disable Steam Cloud for app 1260520.
2. Close notifications and unrelated windows; verify no secrets are visible.
3. Run `npm run doctor` and require every required check to pass.
4. Run `node dist/src/cli.js smoke-model`; do not start a formal run unless it succeeds.
5. Run `npm run demo` once to verify the director dashboard fits the intended crop.
6. Ensure enough free space for a long 30 FPS Matroska recording and connect stable power/network. The model API needs network; the model itself has no search or network-capable tool.

## During the take

The runner opens the native game and the compact director dashboard side by side, then records the entire primary Wayland output. Do not interact after the timer starts. If human intervention is unavoidable, mark the run invalid and retain it only as a rehearsal.

The director dashboard shows:

- exact wall-clock elapsed time;
- Codex-reported cumulative tokens and their breakdown;
- referee progress for viewers only;
- model/status and the no-search badge; and
- sanitized live reasoning summaries and MCP tool calls.

The dashboard does not send commands and is not visible to the model.

## After the take

1. Confirm `summary.json` says `completed`, `364/364`, and `savesRestored: true`.
2. Run the test suite again at the exact commit used for the challenge.
3. Verify `manifest.sha256.json` against the artifacts.
4. Transcode the Matroska master to the platform delivery format; retain the original master.
5. Put the repository commit SHA, model, effort, Codex version, timer, token breakdown, prompt, and artifact manifest hash in the video description.
6. Review raw logs, save files, browser profile, and frames before publishing. Do not upload credentials, local paths that reveal private information, or proprietary game data beyond footage permitted by the rights holder/platform.

Recommended video framing is 2560×1440 or 1920×1080, with the game using roughly two thirds of the width. Preserve legible token/time figures at the final delivery resolution.
