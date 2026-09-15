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

test("viewer layout validation follows the current socket and is released on disconnect", async () => {
  const sockets = new KioskConnections();
  const old = { terminate() {} }, current = { terminate() {} };
  sockets.set("viewer", {
    id: "viewer", name: "Viewer", ws: old, lastPong: 1,
    validateViewerLayout: async (layoutId) => layoutId === "old-layout",
    validateViewerPower: async () => false,
  });
  sockets.set("viewer", {
    id: "viewer", name: "Viewer", ws: current, lastPong: 2,
    validateViewerLayout: async (layoutId) => layoutId === "current-layout",
    validateViewerPower: async () => true,
  });

  assert.equal(sockets.removeSocket("viewer", old), false);
  assert.equal(await sockets.get("viewer")?.validateViewerPower?.({ type: "wake" }), true);
  assert.equal(await sockets.get("viewer")?.validateViewerLayout?.("current-layout"), true);
  assert.equal(await sockets.get("viewer")?.validateViewerLayout?.("old-layout"), false);
  assert.equal(sockets.removeSocket("viewer", current), true);
  assert.equal(sockets.get("viewer")?.validateViewerLayout, undefined);
  assert.equal(sockets.get("viewer")?.validateViewerPower, undefined);
  assert.equal(sockets.size, 0);
});

test("desktop replacement and service cleanup release viewer layout validators", () => {
  const sockets = new KioskConnections();
  const viewer = { terminate() {} }, desktop = { terminate() {} };
  const connection = {
    id: "k1", name: "Viewer", ws: viewer, lastPong: 1,
    validateViewerLayout: async () => true,
    validateViewerPower: async () => true,
  };
  sockets.set("k1", connection);
  sockets.set("k1", { id: "k1", name: "Desktop", ws: desktop, lastPong: 2 });
  assert.equal(sockets.get("k1")?.validateViewerLayout, undefined);
  assert.equal(sockets.get("k1")?.validateViewerPower, undefined);

  sockets.set("k2", { ...connection, id: "k2" });
  sockets.clear();
  assert.equal(sockets.size, 0);
  assert.equal(sockets.get("k2")?.validateViewerLayout, undefined);
  assert.equal(sockets.get("k2")?.validateViewerPower, undefined);
});
