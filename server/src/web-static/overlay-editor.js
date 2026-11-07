(() => {
  const editor = document.getElementById("overlay-editor");
  if (!editor) return;
  const html = document.getElementById("overlay-html");
  const sample = document.getElementById("overlay-sample");
  const preview = document.getElementById("overlay-preview");
  const error = document.getElementById("overlay-preview-error");
  let timer, pending, generation = 0;
  async function render(version) {
    try {
      const data = JSON.parse(sample.value);
      const response = await fetch("/admin/overlays/preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ html: html.value, data }), signal: pending.signal,
      });
      const result = await response.json();
      if (version !== generation) return;
      if (!response.ok) throw new Error(result.error || "Unable to render preview");
      preview.srcdoc = result.document;
      error.textContent = "";
    } catch (cause) {
      if (version === generation && cause.name !== "AbortError") error.textContent = cause.message;
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (pending) pending.abort();
    pending = new AbortController();
    const version = ++generation;
    timer = setTimeout(() => render(version), 200);
  }
  html.addEventListener("input", schedule);
  sample.addEventListener("input", schedule);
  document.getElementById("overlay-size").addEventListener("change", event => {
    const [width, height] = event.target.value.split(",");
    preview.parentElement.style.width = width + "px";
    preview.parentElement.style.height = height + "px";
  });
  schedule();
})();
