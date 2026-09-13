import assert from "node:assert/strict";
import test from "node:test";
import { KioskConnections } from "../src/shared/kiosk-connections.js";

test("delayed close and pong from a previous socket cannot affect its replacement", () => {
  const sockets = new KioskConnections();
  const old = { terminate() {} }, current = { terminate() {} };
  sockets.set("k1", { id: "k1", name: "test", ws: old, lastPong: 1 });
  sockets.set("k1", { id: "k1", name: "test", ws: current, lastPong: 2 });
  assert.equal(sockets.removeSocket("k1", old), false);
  sockets.pong("k1", old, 100);
  assert.equal(sockets.get("k1")?.lastPong, 2);
  assert.equal(sockets.get("k1")?.ws, current);
  assert.equal(sockets.removeSocket("k1", current), true);
});

test("a missed heartbeat terminates stale connections while active ones survive", () => {
  const terminated: string[] = [];
  const sockets = new KioskConnections();
  sockets.set("old", { id: "old", name: "old", ws: { terminate: () => terminated.push("old") }, lastPong: 0 });
  const live = { terminate: () => terminated.push("live") };
  sockets.set("live", { id: "live", name: "live", ws: live, lastPong: 0 });
  sockets.pong("live", live, 90_000);
  sockets.terminateStale(100_000);
  assert.deepEqual(terminated, ["old"]);
});
