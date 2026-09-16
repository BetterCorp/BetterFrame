const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { createRequire } = require('node:module');
const fixtureRequire = process.env.BF_SOCKET_TEST_MODULES ? createRequire(process.env.BF_SOCKET_TEST_MODULES + '/package.json') : require;
const { Server } = fixtureRequire('socket.io');
const { io } = fixtureRequire('socket.io-client');
const { scopeSocket } = require('./display-scope.cjs');
const once = (socket, event) => new Promise(resolve => socket.once(event, (...args) => resolve(args)));
const config = {
  futurePrivateField: { secret: true }, meta: { private: true }, heads: { private: true }, dashboards: { base: {}, other: {} },
  pages: { allowed: { ui: 'base', theme: 'theme' }, denied: { ui: 'base', theme: 'private' } },
  groups: { group: { page: 'allowed' }, secret: { page: 'denied' } },
  widgets: { barrier: { props: { group: 'group' } }, widget: { props: { group: 'group' } }, deniedWidget: { props: { group: 'secret' } }, global: { props: {} }, custom: { src: '/custom', props: { group: 'group' } } },
  themes: { theme: {}, private: {} },
};
test('real Socket.IO filters direct/broadcast/binary packets and incoming widgets, reauthorizes on lease expiry', { timeout: 15_000 }, async () => {
  const http = createServer(); const server = new Server(http);
  let pages = ['allowed']; let connections = 0; let incoming = [];
  server.use((socket, next) => { if (!socket.handshake.auth.admin) scopeSocket(socket, { pages, expires: Date.now() + 1500 }); next(); });
  server.on('connection', socket => {
    connections++;
    socket.emit('ui-config', 'base', config);
    socket.on('widget-action', id => { if (id === 'barrier') socket.emit('widget-sync:barrier', 'barrier'); else incoming.push(id); });
    socket.on('custom-secret', id => incoming.push(id));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const client = io(`http://127.0.0.1:${http.address().port}`, { reconnectionDelay: 10 });
  const admin = io(`http://127.0.0.1:${http.address().port}`, { auth: { admin: true } });
  const adminConfig = once(admin, 'ui-config');
  const barrier = async () => { const next = once(client, 'widget-sync:barrier'); client.emit('widget-action', 'barrier'); await next; };
  const received = []; client.onAny((...args) => received.push(args));
  try {
    const [, initial] = await once(client, 'ui-config');
    assert.deepEqual(Object.keys(initial.pages), ['allowed']);
    assert.deepEqual(Object.keys(initial.widgets), ['barrier', 'widget']);
    assert.equal(initial.futurePrivateField, undefined);
    assert.deepEqual((await adminConfig)[1], config);
    assert.deepEqual(Object.keys(initial.themes), ['theme']);
    assert.deepEqual(initial.heads, {});
    const socket = [...server.sockets.sockets.values()].find(item => !item.handshake.auth.admin);
    const data = Buffer.from('public binary');
    socket.emit('msg-input:deniedWidget', 'private-direct');
    const adminBroadcast = once(admin, 'msg-input:deniedWidget');
    server.emit('msg-input:deniedWidget', Buffer.from('private-broadcast'));
    assert.deepEqual((await adminBroadcast)[0], Buffer.from('private-broadcast'));
    server.to(socket.id).emit('widget-sync:deniedWidget', 'private-room');
    server.emit('unknown-plugin', 'private');
    const binary = once(client, 'msg-input:widget');
    server.emit('msg-input:widget', data);
    assert.deepEqual((await binary)[0], data);
    client.emit('widget-action', 'deniedWidget', {});
    client.emit('custom-secret', 'widget', {});
    client.emit('widget-action', 'widget', {});
    await barrier();
    assert.deepEqual(incoming, ['widget']);
    assert.equal(received.some(([event]) => /denied|unknown/.test(event)), false);
    // Re-deploy moves a formerly allowed widget to an unassigned page.
    const update = structuredClone(config); update.widgets.widget.props.group = 'secret';
    const updated = once(client, 'ui-config'); server.emit('ui-config', 'base', update); await updated;
    server.emit('msg-input:widget', 'moved-private');
    client.emit('widget-action', 'widget', {});
    await barrier(); assert.deepEqual(incoming, ['widget']);
    assert.equal(received.some(([, value]) => value === 'moved-private'), false);
    pages = ['denied'];
    const fresh = once(client, 'ui-config');
    const [, nextConfig] = await fresh;
    assert.ok(connections >= 2, 'engine close triggered automatic reconnect');
    assert.deepEqual(Object.keys(nextConfig.pages), ['denied']);
    assert.deepEqual(Object.keys(nextConfig.widgets), ['deniedWidget']);
  } finally { client.close(); admin.close(); await new Promise(resolve => server.close(resolve)); }
});
