let playbackUrl = null;

async function authenticatedFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    location.href = "/operator/";
    throw new Error("unauthorized");
  }
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`);
  return response;
}

async function activateLayout(displayId, layoutId, label) {
  const status = document.getElementById("push-state");
  try {
    await authenticatedFetch(`/operator/api/displays/${encodeURIComponent(displayId)}/layouts/${encodeURIComponent(layoutId)}`, { method: "POST" });
    status.textContent = `${label} sent to display.`;
  } catch (error) {
    status.textContent = error.message;
  }
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
      item.textContent = cell.camera_name || `${cell.id} · ${cell.content_type === "none" ? "Empty" : cell.content_type}`;
      cells.append(item);
    }
    const layoutTitle = document.createElement("h3");
    layoutTitle.textContent = "Quick layouts";
    const layouts = document.createElement("div");
    layouts.className = "layout-buttons";
    for (const layout of display.layouts) {
      const button = document.createElement("button");
      button.textContent = `${layout.name}${layout.is_default ? " · Default" : ""}`;
      button.onclick = () => activateLayout(display.id, layout.id, layout.name);
      layouts.append(button);
    }
    card.append(title, cells, layoutTitle, layouts);
    return card;
  }));

  const contentDisplay = document.getElementById("content-display");
  for (const display of data.displays) {
    const option = document.createElement("option");
    option.value = display.id;
    option.textContent = display.name;
    contentDisplay.append(option);
  }
  const content = document.getElementById("content-grid");
  if (!data.content.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No web, HTML, dashboard, or AbleSign content is configured.";
    content.replaceChildren(empty);
  } else {
    content.replaceChildren(...data.content.map(item => {
      const card = document.createElement("article");
      card.className = "panel tool-card";
      const name = document.createElement("div");
      name.textContent = item.name;
      const detail = document.createElement("div");
      detail.className = "muted";
      detail.textContent = item.source || item.type;
      const button = document.createElement("button");
      button.textContent = "Push full-screen";
      button.onclick = () => activateLayout(contentDisplay.value, item.id, item.name);
      card.append(name, detail, button);
      return card;
    }));
  }

  const tools = document.getElementById("tool-grid");
  tools.replaceChildren(...data.tools.map(tool => {
    const link = document.createElement("a");
    link.className = "panel tool-card";
    link.href = tool.url;
    link.textContent = `${tool.label} →`;
    return link;
  }));

  if (!data.simple_vms.enabled) return;
  const panel = document.getElementById("playback-panel");
  panel.classList.remove("hidden");
  const cameras = data.cameras.filter(camera => camera.playback_path);
  const status = document.getElementById("vms-state");
  if (!cameras.length) {
    status.textContent = "Recording is enabled but has no managed cameras.";
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
boot().catch(error => document.getElementById("push-state").textContent = error.message);
