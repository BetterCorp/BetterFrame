// FlowFuse Dashboard 2 display sessions are page-scoped, including transport.
// Unknown plugin events and global templates are intentionally unavailable.
const ADAPTER_GUARD = Symbol.for('betterframe.displayAdapter');
const SOCKET_GUARD = Symbol.for('betterframe.displaySocket');

function scopeSocket(socket, scope) {
  if (!scope || !Array.isArray(scope.pages) || !scope.pages.length || !Number.isFinite(scope.expires) || scope.expires <= Date.now()) {
    throw new Error('invalid display scope');
  }
  const pages = new Set(scope.pages);
  let widgets = new Set();
  const expired = () => Date.now() >= scope.expires;
  const subset = (entries, predicate) => Object.fromEntries(Object.entries(entries || {}).filter(([id, value]) => predicate(value, id)));
  function filter(packet) {
    if (expired()) { socket.conn.close(); return null; }
    // Socket.IO CONNECT / DISCONNECT contain no application data.
    if (packet.type === 0 || packet.type === 1) return packet;
    if (![2, 5].includes(packet.type) || !Array.isArray(packet.data)) return null;
    const [event, ...args] = packet.data;
    if (event === 'ui-config') {
      const [base, config] = args;
      if (!config || typeof config !== 'object') return null;
      const filteredPages = subset(config.pages, (page, id) => pages.has(id) && page.type !== 'ui-link' && page.ui === base);
      const groups = subset(config.groups, (group) => Object.hasOwn(filteredPages, group.page));
      const allowedWidgets = subset(config.widgets, (widget) => !widget.src && (
        Object.hasOwn(groups, widget.props?.group) || Object.hasOwn(filteredPages, widget.props?.page)
      ));
      widgets = new Set(Object.keys(allowedWidgets));
      const themes = new Set(Object.values(filteredPages).map(page => page.theme));
      return { ...packet, data: [event, base, {
        meta: {}, heads: {},
        dashboards: subset(config.dashboards, (_, id) => id === base),
        pages: filteredPages, groups, widgets: allowedWidgets,
        themes: subset(config.themes, (_, id) => themes.has(id)),
      }] };
    }
    const match = typeof event === 'string' && /^(?:widget-load|widget-sync|msg-input):(.+)$/.exec(event);
    return match && widgets.has(match[1]) ? packet : null;
  }
  socket[SOCKET_GUARD] = filter;
  const originalPacket = socket.packet.bind(socket);
  socket.packet = (packet, ...args) => {
    const safe = filter(packet);
    if (safe) originalPacket(safe, ...args);
  };
  // Socket.IO adapter broadcasts bypass socket.packet. Route scoped recipients
  // through the same filter before the adapter encodes JSON/binary attachments.
  const adapter = socket.nsp.adapter;
  if (!adapter[ADAPTER_GUARD]) {
    adapter[ADAPTER_GUARD] = true;
    const originalBroadcast = adapter.broadcast.bind(adapter);
    adapter.broadcast = (packet, options) => {
      const excluded = new Set(options.except || []);
      adapter.apply(options, (recipient) => {
        if (recipient[SOCKET_GUARD]) {
          excluded.add(recipient.id);
          recipient.packet(packet, options.flags || {});
        }
      });
      originalBroadcast(packet, { ...options, except: excluded });
    };
    const originalBroadcastWithAck = adapter.broadcastWithAck.bind(adapter);
    adapter.broadcastWithAck = (packet, options, ...callbacks) => {
      const excluded = new Set(options.except || []);
      for (const recipient of socket.nsp.sockets.values()) if (recipient[SOCKET_GUARD]) excluded.add(recipient.id);
      // Custom broadcast acknowledgements are not part of the supported viewer protocol.
      originalBroadcastWithAck(packet, { ...options, except: excluded }, ...callbacks);
    };
  }
  socket.use(([event, id], next) => {
    if (expired()) { socket.conn.close(); return; }
    if (/^widget-(?:send|action|change|load)$/.test(event) && widgets.has(id)) next();
    // Reject unknown events and unassigned widget IDs without executing handlers.
  });
  // Engine transport close makes Socket.IO reconnect and obtain a fresh lease.
  // socket.disconnect(true) would disable the client's automatic reconnection.
  const timer = setTimeout(() => socket.conn.close(), Math.max(1, scope.expires - Date.now()));
  timer.unref?.();
  socket.once('disconnect', () => clearTimeout(timer));
}
module.exports = { scopeSocket };
