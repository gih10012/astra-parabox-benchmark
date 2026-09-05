# Benchmark protocol

## Fixed challenge definition

- Start from no Patrick's Parabox save slots and finish when a runtime-only referee observes exactly 364 completed entries out of 364 official entries.
- Give GPT-6-Astra exactly one user message: `Complete all 364 official levels in Patrick's Parabox. Interact only through the provided tools.`
- Use `high` reasoning effort by default. A different effort makes a distinct benchmark run and must be shown in its metadata.
- Completion is the hard requirement. Wall-clock time and token use are reported as separate metrics; they are not combined into a score.

## Model-visible surface

Only four MCP tools are enabled:

1. `observe_game()` returns a current JPEG screenshot of the native game window.
2. `press_keys(keys, intervalMs, settleMs, capture)` focuses the game, types a bounded sequence of allowed keyboard keys, and normally returns the resulting frame.
3. `challenge_time()` returns the official elapsed time snapshot.
4. `challenge_tokens()` returns the latest cumulative token snapshot.

The game adapter never reads process memory, game assets, level definitions, save files, OCR, accessibility trees, or symbolic state for the model. The referee reads the save only to determine progress and completion, and does not expose that value through MCP.

Codex starts with user config and exec rules ignored. Web search, shell, local image tools, browser/computer use, apps, plugins, skills, memories, hooks, and multi-agent tools are disabled. The MCP allowlist contains only the four tools above.

## Metric boundaries

- The monotonic timer starts immediately before the `codex exec` process is spawned, after the clean game window, controller, layout, and recorder are ready.
- The timer freezes on the first referee sample showing 364/364. Setup, teardown, video finalization, and original-save restoration are excluded.
- There is no pause mechanism. A crash or early model exit is a failed run, not a paused run.
- Token usage is read from Codex's cumulative `token_count.info.total_token_usage` rollout events during the turn and reconciled with final `turn.completed.usage` from `codex exec --json`.
- `totalTokens` uses Codex's reported total. Cached input is reported separately and is not added a second time. Reasoning output is reported separately as the provider's breakdown.
- A mid-run token query is necessarily a slightly stale sample and cannot include the tokens used to emit that same query. The final summary is authoritative.

## Audit artifacts

Every run records:

- immutable run metadata and the exact neutral prompt;
- redacted Codex command/configuration;
- raw `codex exec --json` events and incremental usage events;
- dashboard/referee events and final summary;
- recoverable original-save backup and completed challenge save;
- full-screen Matroska recording; and
- a SHA-256 manifest over all run artifacts.

Run artifacts can contain copyrighted screenshots and private local state. Review them before public release. Publish hashes even when large or sensitive raw artifacts are withheld.
