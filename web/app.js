const byId = (id) => document.getElementById(id);
const state = { snapshot: null, localReceivedAt: 0, transcriptKeys: new Set() };

if (new URLSearchParams(location.search).get("compact") === "1") {
  document.body.classList.add("compact");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatElapsed(milliseconds) {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":") + `.${String(millis).padStart(3, "0")}`;
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  state.localReceivedAt = performance.now();
  byId("tokens").textContent = formatNumber(snapshot.tokens.totalTokens);
  byId("token-breakdown").textContent =
    `${formatNumber(snapshot.tokens.inputTokens)} in · ` +
    `${formatNumber(snapshot.tokens.outputTokens)} out`;
  byId("complete").textContent = formatNumber(snapshot.progress.completed);
  byId("progress-bar").style.width =
    `${Math.min(100, (snapshot.progress.completed / snapshot.targetLevels) * 100)}%`;
  byId("model").textContent = snapshot.model.toUpperCase();
  byId("status").textContent = snapshot.status.toUpperCase();
  byId("run-id").textContent = snapshot.runId || "not started";
}

function tick() {
  if (state.snapshot) {
    const runningDelta = state.snapshot.status === "running"
      ? performance.now() - state.localReceivedAt
      : 0;
    byId("elapsed").textContent = formatElapsed(
      state.snapshot.time.elapsedMs + runningDelta,
    );
  }
  requestAnimationFrame(tick);
}

function addTranscript(event) {
  const key = JSON.stringify(event);
  if (state.transcriptKeys.has(key)) return;
  state.transcriptKeys.add(key);
  const item = event.item || {};
  const row = document.createElement("div");
  const kind = item.type || event.type || "system";
  row.className = `event ${kind === "mcp_tool_call" ? "tool" : kind.replace("_message", "")}`;
  const time = document.createElement("time");
  time.textContent = kind === "mcp_tool_call" ? "TOOL" : kind.slice(0, 5).toUpperCase();
  const body = document.createElement("p");
  if (item.text) body.textContent = item.text;
  else if (kind === "mcp_tool_call") {
    body.textContent = `${item.server || "mcp"}.${item.tool || "tool"} ${JSON.stringify(item.arguments || {})}`;
  } else body.textContent = event.type || kind;
  row.append(time, body);
  byId("transcript").append(row);
  row.scrollIntoView({ block: "end" });
}

async function bootstrap() {
  const [snapshot, transcript] = await Promise.all([
    fetch("/api/challenge").then((response) => response.json()),
    fetch("/api/transcript").then((response) => response.json()),
  ]);
  applySnapshot(snapshot);
  transcript.forEach(addTranscript);
  const frameResponse = await fetch("/api/frame");
  if (frameResponse.ok && frameResponse.status !== 204) {
    const image = byId("game-frame");
    image.src = "/api/frame?v=initial";
    image.style.display = "block";
    byId("frame-placeholder").style.display = "none";
    byId("frame-time").textContent = "latest frame";
  }
}

const events = new EventSource("/api/events");
events.addEventListener("state", (event) => applySnapshot(JSON.parse(event.data)));
events.addEventListener("transcript", (event) => addTranscript(JSON.parse(event.data)));
events.addEventListener("frame", (event) => {
  const detail = JSON.parse(event.data);
  const image = byId("game-frame");
  image.src = `/api/frame?v=${encodeURIComponent(detail.sha256)}`;
  image.style.display = "block";
  byId("frame-placeholder").style.display = "none";
  byId("frame-time").textContent = detail.capturedAt;
});

bootstrap().catch((error) => addTranscript({ type: "error", item: { text: error.message } }));
tick();
