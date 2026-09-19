(() => {
  const viewer = document.querySelector('.log-viewer');
  if (!viewer) return;
  const status = viewer.querySelector('[data-log-status]');
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = element('button', text, 'btn btn-sm btn-ghost');
    node.type = 'button'; node.addEventListener('click', action); return node;
  };
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); status.textContent = 'Copied.'; }
    catch { status.textContent = 'Clipboard unavailable. Select the text to copy it.'; }
  }
  function render(body, log) {
    const toolbar = element('div', null, 'log-detail-toolbar');
    toolbar.append(element('h3', 'Message'), button('Copy message', () => copy(log.message)), button('Download JSON', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], {type: 'application/json'}));
      const link = element('a'); link.href = url; link.download = `log-${log.id}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    const kioskLink = element('a', 'Kiosk logs', 'btn btn-sm btn-ghost');
    kioskLink.href = `/admin/kiosks/${encodeURIComponent(log.kiosk_id)}/diagnostics`;
    toolbar.append(kioskLink);
    const metadata = element('dl', null, 'log-metadata');
    for (const [label, value] of [['Event time (UTC)', log.logged_at], ['Received (UTC)', log.received_at], ['Kiosk ID', log.kiosk_id], ['Log ID', log.id]]) {
      metadata.append(element('dt', label), element('dd', value));
    }
    const context = element('details', null, 'log-context');
    context.append(element('summary', 'Structured context'), button('Copy context', () => copy(JSON.stringify(log.context, null, 2))), element('pre', JSON.stringify(log.context, null, 2)));
    // Treat every uploaded field as text, including multiline HTML/stack traces.
    body.replaceChildren(toolbar, element('pre', log.message, 'log-full-message'), metadata, context);
    if (log.context?.truncated) body.prepend(element('p', 'Message truncated by the collector at 16,384 characters.', 'log-muted'));
  }
  viewer.querySelectorAll('.log-entry').forEach(entry => {
    let loaded = false, loading = false;
    const body = entry.querySelector('.log-detail');
    async function load() {
      if (loaded || loading) return;
      loading = true;
      body.replaceChildren(element('p', 'Loading details…', 'log-muted'));
      try {
        const response = await fetch(entry.dataset.logUrl, {headers: {accept: 'application/json'}, cache: 'no-store'});
        if (!response.ok) throw new Error(response.status === 404 ? 'This log expired or is no longer available.' : 'Could not load this log.');
        if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Session expired. Reload to sign in.');
        const log = await response.json();
        render(body, log); loaded = true;
      } catch (error) {
        body.replaceChildren(element('p', error.message || 'Could not load this log.', 'log-muted'), button('Retry', load));
      } finally { loading = false; }
    }
    entry.addEventListener('toggle', () => { if (entry.open) void load(); });
  });
  viewer.querySelector('[data-log-wrap]').addEventListener('change', event => viewer.classList.toggle('logs-nowrap', !event.target.checked));
  viewer.querySelector('[data-log-collapse]').addEventListener('click', () => viewer.querySelectorAll('.log-entry[open]').forEach(entry => { entry.open = false; }));
})();
