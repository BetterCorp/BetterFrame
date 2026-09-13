import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import { createCoordinatorWebSocketServer, COORDINATOR_MAX_PAYLOAD_BYTES } from "../src/shared/coordinator-websocket.js";

async function connect(t: TestContext) {
  const server = createServer();
  const wss = createCoordinatorWebSocketServer();
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (peer) => wss.emit("connection", peer));
  });
  t.after(async () => {
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connected = once(wss, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  t.after(() => client.terminate());
  const [peer] = await connected as [WebSocket];
  await once(client, "open");
  return { client, peer };
}

test("coordinator accepts a full 10 MiB camera snapshot and keeps the socket usable", { timeout: 10_000 }, async (t) => {
  const { client, peer } = await connect(t);
  const body = Buffer.alloc(10 * 1024 * 1024, 0xa5);
  const message = JSON.stringify({
    type: "camera-proxy-response", request_id: "d8228824-cbf6-4057-9cd9-47caa378bcec",
    status: 200, content_type: "image/jpeg", body_b64: body.toString("base64"),
  });
  const received = once(peer, "message");
  client.send(message);
  const [payload] = await received;
  const response = JSON.parse(payload.toString());
  assert.equal(response.type, "camera-proxy-response");
  assert.deepEqual(Buffer.from(response.body_b64, "base64"), body);
  const pong = once(peer, "message");
  client.send('{"type":"pong"}');
  assert.equal((await pong)[0].toString(), '{"type":"pong"}');
  assert.equal(client.readyState, WebSocket.OPEN);
});

test("coordinator still closes messages above the finite transport limit", { timeout: 10_000 }, async (t) => {
  const { client, peer } = await connect(t);
  const error = once(peer, "error");
  const closed = once(client, "close");
  client.send(Buffer.alloc(COORDINATOR_MAX_PAYLOAD_BYTES + 1));
  assert.equal(((await error)[0] as NodeJS.ErrnoException).code, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
  assert.equal((await closed)[0], 1009);
});
