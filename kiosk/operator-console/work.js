const TOKEN_KEY = "betterframe.operator.stationToken";
const token = () => localStorage.getItem(TOKEN_KEY) || "";
let playbackUrl = null;

async function authenticatedFetch(path) {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token()}` } });
  if (response.status === 401) {
    location.href = "/operator/";
    throw new Error("unauthorized");
  }
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`);
  return response;
}

async function boot() {
  const data = await (await authenticatedFetch("/operator/api/bootstrap")).json();
  const overview = document.getElementById("wall-overview");
  overview.replaceChildren(...data.displays.map(display => {
    const card = document.createElement("article");
    card.className = "panel display-card";
    const title = document.createElement("h2");
    title.textContent = display.name;
    const cells = document.createElement("div");
    cells.className = "cell-list";
    for (const cell of display.cells) {
      const item = document.createElement("div");
      item.className = "cell-pill";
      item.textContent = cell.camera_name || `${cell.id} · Empty`;
      cells.append(item);
    }
    card.append(title, cells);
    return card;
  }));

  const tools = document.getElementById("tool-grid");
  tools.replaceChildren(...data.tools.map(tool => {
    const link = document.createElement("a");
    link.className = "panel tool-card";
    link.href = tool.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `${tool.label} ↗`;
    return link;
  }));

  const cameras = data.cameras.filter(camera => camera.playback_path);
  const status = document.getElementById("vms-state");
  if (!data.simple_vms.enabled || !cameras.length) {
    status.textContent = "SimpleVMS is not enabled or has no managed cameras.";
    return;
  }
  status.textContent = "Choose a camera and recording start time.";
  const controls = document.getElementById("playback-controls");
  controls.classList.remove("hidden");
  const select = document.getElementById("playback-camera");
  for (const camera of cameras) {
    const option = document.createElement("option");
    option.value = camera.playback_path;
    option.textContent = camera.camera_number ? `${camera.camera_number} · ${camera.name}` : camera.name;
    select.append(option);
  }
  const start = new Date(Date.now() - 5 * 60 * 1000);
  document.getElementById("playback-start").value = new Date(start.getTime() - start.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

document.getElementById("playback-load").onclick = async () => {
  const status = document.getElementById("vms-state");
  const startValue = document.getElementById("playback-start").value;
  if (!startValue) return;
  status.textContent = "Loading recording…";
  try {
    const query = new URLSearchParams({
      path: document.getElementById("playback-camera").value,
      start: new Date(startValue).toISOString(),
      duration: document.getElementById("playback-duration").value,
      format: "mp4",
    });
    const blob = await (await authenticatedFetch(`/operator/playback/get?${query}`)).blob();
    if (playbackUrl) URL.revokeObjectURL(playbackUrl);
    playbackUrl = URL.createObjectURL(blob);
    const video = document.getElementById("playback-video");
    video.src = playbackUrl;
    await video.play();
    const download = document.getElementById("playback-download");
    download.href = playbackUrl;
    download.download = `betterframe-${Date.now()}.mp4`;
    download.classList.remove("hidden");
    status.textContent = "Recording loaded.";
  } catch (error) {
    status.textContent = error.message;
  }
};

window.addEventListener("beforeunload", () => playbackUrl && URL.revokeObjectURL(playbackUrl));
boot().catch(error => document.getElementById("vms-state").textContent = error.message);
