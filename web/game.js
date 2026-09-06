const frame = document.getElementById("frame");

async function loadInitialFrame() {
  const response = await fetch("/api/frame");
  if (response.ok && response.status !== 204) frame.src = "/api/frame?v=initial";
}

const events = new EventSource("/api/events");
events.addEventListener("frame", (event) => {
  const detail = JSON.parse(event.data);
  frame.src = `/api/frame?v=${encodeURIComponent(detail.sha256)}`;
});

void loadInitialFrame();
