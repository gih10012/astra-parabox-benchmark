# Astra × Parabox Benchmark

A reproducible, screen-only benchmark harness for testing whether GPT-6-Astra can complete all **364 official levels** of Patrick's Parabox from a clean save.

The model receives one neutral task sentence, rendered game frames, keyboard actions, and two self-inspection tools for elapsed time and token usage. It receives no walkthrough, level data, or save contents. Native web search and network browsers are disabled; normal Codex capabilities such as Shell, skills, plugins, memory, and sub-agents remain available.

> This repository contains no game binary, game assets, save data, or recorded footage. A legitimately purchased Steam copy of Patrick's Parabox is required.

## Why this architecture

The native game window remains the sole source of truth. A local MCP bridge captures that window and sends keyboard events. A separate director dashboard renders the Codex event stream and official metrics for the recording.

```text
                    ┌─ observe_game / press_keys ─┐
GPT-6-Astra (Codex) ┤                              ├─ Native game window
                    └─ challenge_time / tokens ───┤
                                                  │
Codex JSONL + rollout usage ── Arena controller ──┼─ Director dashboard
Game save (referee only) ─────────────────────────┘
                                                  │
Wayland output ─────────────────────────── wf-recorder → challenge.mkv
```

The browser is deliberately not the control plane. This avoids a lossy browser reimplementation of the game, cuts latency, and lets viewers see the unmodified native game beside an exact, read-only Codex transcript.

## Requirements

The current implementation targets Linux with:

- Node.js 22+
- Codex CLI with `gpt-6-astra`
- Patrick's Parabox (Steam app `1260520`)
- Wayland with the niri compositor
- `wtype`, FFmpeg, `wf-recorder`, Steam, and optionally Google Chrome

Install and verify:

```bash
npm install
npm run build
npm run doctor
```

By default, the harness uses `~/.codex-official` when that directory contains `auth.json`, then falls back to the normal Codex home. Override it with `--codex-home PATH` or `ASTRA_CODEX_HOME`. Credentials are never copied into run artifacts.

Validate authentication and the four benchmark-specific MCP tools with a small, non-challenge GPT-6-Astra turn before touching saves:

```bash
node dist/src/cli.js smoke-model
```

Preview the director dashboard without touching the game or using model tokens:

```bash
npm run demo
```

## Formal run

Before a recorded run, disable Steam Cloud for Patrick's Parabox and close the game. The harness temporarily moves existing `save*.txt` files into the run's recoverable backup, starts with no save slots, archives the challenge save at the end, and restores the originals.

```bash
npm run build
node dist/src/cli.js run
```

Defaults:

- model: `gpt-6-astra`
- reasoning effort: `high`
- completion: exactly `364/364`
- prompt: `Complete all 364 official levels in Patrick's Parabox. Use the Parabox tools for game observation and control. Do not search or browse the internet.`
- recording: 30 FPS Matroska, full primary output
- UI: native game at 67%, director dashboard at 33%
- native web search and network browsers: disabled
- Shell: enabled in an empty writable workspace, with outbound network disabled
- skills, plugins, apps, memory, and sub-agents: retained from the selected Codex home

Useful variants:

```bash
node dist/src/cli.js run --reasoning xhigh
node dist/src/cli.js run --codex-home ~/.codex-official
node dist/src/cli.js run --no-record --no-browser
node dist/src/cli.js restore runs/<run-id>/save-recovery.json
```

Run artifacts are written under `runs/` and ignored by Git. Each run ends with a SHA-256 manifest. Keep the raw artifacts next to the published video or release them separately; do not commit game frames or save files to this repository.

## Public interfaces

The loopback director server exposes:

- `GET /api/challenge/time` — official monotonic elapsed time
- `GET /api/challenge/tokens` — cumulative input, cached input, output, reasoning output, and total tokens
- `GET /api/challenge` — dashboard snapshot, including referee-only visible progress
- `GET /api/events` — Server-Sent Events for state and transcript updates

Codex receives matching MCP tools named `challenge_time` and `challenge_tokens`, plus `observe_game` and `press_keys`. The progress counter is intentionally not returned to Codex because it is derived from the save file rather than pixels.

The runner follows the documented `codex exec --json` stream and the local rollout's incremental token events. See the [Codex non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The selected Codex home and its normal configuration stay active. The runner adds the Parabox MCP server, forces the official `gpt-6-astra` model, disables native web search and browser features, and uses a `workspace-write` sandbox with command network access off. Because app, plugin, and MCP traffic is outside the command sandbox, using any of them to retrieve external puzzle information invalidates the run; the complete Codex event stream is retained for audit.

## Reproducibility

The exact rules, timing boundary, accounting semantics, and allowed tool surface are fixed in [docs/PROTOCOL.md](docs/PROTOCOL.md). Recording and publishing guidance is in [docs/RECORDING.md](docs/RECORDING.md).

Patrick's Parabox is the property of its respective rights holders. This project is unaffiliated with Patrick Traynor or OpenAI.
