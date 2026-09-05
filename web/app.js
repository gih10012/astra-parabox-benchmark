const byId = (id) => document.getElementById(id);
const state = {
  snapshot: null,
  localReceivedAt: 0,
  transcriptSequences: new Set(),
  itemRows: new Map(),
};

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
  byId("run-id").textContent = snapshot.runId
    ? `${snapshot.runId} · PART ${String(snapshot.attempt || 1).padStart(4, "0")}`
    : "not started";
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

function stringify(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function addText(container, text, className = "") {
  if (text === undefined || text === null || text === "") return;
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = String(text);
  container.append(paragraph);
}

function addCode(container, label, value, className = "") {
  if (value === undefined || value === null || value === "") return;
  const block = document.createElement("div");
  block.className = `event-detail ${className}`.trim();
  if (label) {
    const heading = document.createElement("span");
    heading.textContent = label;
    block.append(heading);
  }
  const code = document.createElement("pre");
  const text = stringify(value);
  const lines = text.split("\n");
  if (lines.length > 14) {
    code.textContent = [
      ...lines.slice(0, 8),
      `… +${lines.length - 12} lines`,
      ...lines.slice(-4),
    ].join("\n");
    code.title = text;
  } else {
    code.textContent = text;
  }
  block.append(code);
  container.append(block);
}

function eventPresentation(event) {
  const item = event.item && typeof event.item === "object" ? event.item : null;
  const itemType = item?.type || "";
  const eventType = event.type || "event";
  const status = item?.status || "";
  const complete = eventType === "item.completed" || status === "completed";
  const failed = eventType.includes("error") || itemType === "error" || status === "failed";

  if (itemType === "agent_message") {
    return { label: "CODEX", kind: "agent", title: item.text || "" };
  }
  if (itemType === "reasoning") {
    return { label: "THINK", kind: "reasoning", title: item.text || "" };
  }
  if (itemType === "command_execution") {
    return {
      label: "SHELL",
      kind: failed ? "error" : "tool",
      title: `${complete ? "Ran" : "Running"} ${item.command || "command"}`,
      details: [
        ["OUTPUT", item.aggregated_output, "output"],
        ["EXIT", item.exit_code, item.exit_code ? "error-text" : ""],
      ],
    };
  }
  if (itemType === "mcp_tool_call") {
    const name = `${item.server || "mcp"}.${item.tool || item.name || "tool"}`;
    return {
      label: "TOOL",
      kind: failed ? "error" : "tool",
      title: `${complete ? "Called" : "Calling"} ${name}`,
      details: [
        ["ARGS", item.arguments],
        ["RESULT", item.result, "output"],
        ["ERROR", item.error, "error-text"],
      ],
    };
  }
  if (itemType === "error") {
    return { label: "ERROR", kind: "error", title: item.message || stringify(item) };
  }
  if (item) {
    const remaining = Object.fromEntries(
      Object.entries(item).filter(([key]) => !["id", "type", "status", "text"].includes(key)),
    );
    return {
      label: itemType.slice(0, 7).toUpperCase() || "ITEM",
      kind: failed ? "error" : "system",
      title: item.text || `${eventType} · ${itemType || "item"}`,
      details: Object.keys(remaining).length ? [["DETAIL", remaining]] : [],
    };
  }
  if (eventType === "thread.started") {
    return {
      label: "THREAD",
      kind: "system",
      title: "Thread started",
      details: [["ID", event.thread_id]],
    };
  }
  if (eventType === "turn.started") {
    return { label: "TURN", kind: "system", title: "Turn started" };
  }
  if (eventType === "turn.completed") {
    return {
      label: "TURN",
      kind: "success",
      title: "Turn completed",
      details: [["USAGE", event.usage]],
    };
  }
  if (eventType === "stderr") {
    return { label: "STDERR", kind: "error", title: event.message || "stderr" };
  }
  if (eventType === "error" || eventType === "runner.error") {
    return { label: "ERROR", kind: "error", title: event.message || stringify(event) };
  }
  if (eventType === "process.started") {
    return { label: "PROC", kind: "system", title: `Started ${event.process}` };
  }
  if (eventType === "process.exited") {
    return {
      label: "PROC",
      kind: event.code === 0 ? "success" : "error",
      title: `${event.process} exited (code=${event.code}, signal=${event.signal})`,
    };
  }
  if (eventType === "runner.ready") {
    return { label: "SYS", kind: "success", title: event.message };
  }
  const remaining = Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== "type"),
  );
  return {
    label: eventType.slice(0, 7).toUpperCase(),
    kind: failed ? "error" : "system",
    title: event.message || eventType,
    details: Object.keys(remaining).length ? [["DETAIL", remaining]] : [],
  };
}

function renderTranscriptRow(row, event) {
  const presentation = eventPresentation(event);
  row.className = `event ${presentation.kind}`;
  row.replaceChildren();
  const label = document.createElement("time");
  label.textContent = presentation.label;
  const body = document.createElement("div");
  body.className = "event-body";
  addText(body, presentation.title, "event-title");
  for (const [detailLabel, value, className] of presentation.details || []) {
    addCode(body, detailLabel, value, className);
  }
  row.append(label, body);
}

function addTranscript(record) {
  const event = record?.event || record;
  const sequence = record?.sequence;
  if (sequence !== undefined) {
    if (state.transcriptSequences.has(sequence)) return;
    state.transcriptSequences.add(sequence);
  }
  byId("transcript").querySelector("[data-placeholder]")?.remove();

  const itemId = event?.item?.id;
  let row = itemId ? state.itemRows.get(itemId) : null;
  if (!row) {
    row = document.createElement("div");
    byId("transcript").append(row);
    if (itemId) state.itemRows.set(itemId, row);
  }
  renderTranscriptRow(row, event || { type: "unknown" });
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

bootstrap().catch((error) => addTranscript({
  type: "error",
  message: error.message,
}));
tick();
