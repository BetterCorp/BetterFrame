import assert from "node:assert/strict";
import test from "node:test";
import { dispatchPower } from "../src/shared/power-dispatch.js";
import type { KioskConnection } from "../src/shared/kiosk-connections.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class Socket {
  readyState = 1;
  writes: string[] = [];
  callback?: (error?: Error) => void;
  failure?: Error;
  terminate() { this.readyState = 3; }
  send(payload: string, callback: (error?: Error) => void) {
    if (this.failure) throw this.failure;
    this.writes.push(payload);
    this.callback = callback;
  }
}
function fixture(validate?: () => Promise<boolean>) {
  const socket = new Socket();
  const connection: KioskConnection<Socket> = { id: "kiosk", name: "Viewer", ws: socket, lastPong: 0,
    ...(validate ? { validateViewerLayout: async () => true, validateViewerPower: validate } : {}) };
  const connections = new Map([["kiosk", connection]]);
  return { socket, connection, connections };
}
const message = { type: "standby", display_id: "assigned" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("power dispatch waits for validation then the socket callback", async () => {
  const validation = deferred<boolean>();
  const f = fixture(() => validation.promise);
  let resolved = false;
  const sent = dispatchPower(f.connections, "kiosk", message).then((value) => { resolved = true; return value; });
  assert.deepEqual(f.socket.writes, []);
  validation.resolve(true);
  await tick();
  assert.deepEqual(f.socket.writes, [JSON.stringify(message)]);
  assert.equal(resolved, false);
  f.socket.callback!();
  assert.equal(await sent, true);
});

test("rejected or failed validation and replaced sockets never send", async () => {
  for (const mode of ["reject", "throw", "replace", "close", "missing-validator"]) {
    const validation = deferred<boolean>();
    const f = fixture(async () => { if (mode === "throw") throw new Error("database unavailable"); return validation.promise; });
    if (mode === "missing-validator") delete f.connection.validateViewerPower;
    const sent = dispatchPower(f.connections, "kiosk", message);
    if (mode === "replace") f.connections.set("kiosk", { ...f.connection, ws: new Socket() });
    if (mode === "close") f.socket.terminate();
    validation.resolve(mode !== "reject");
    assert.equal(await sent, false, mode);
    assert.deepEqual(f.socket.writes, [], mode);
  }
});

test("socket write errors, replacement during writing and timeout never confirm power", async () => {
  for (const mode of ["throw", "callback", "replace", "close", "timeout"]) {
    const f = fixture(); // Desktop clients also require transport confirmation.
    if (mode === "throw") f.socket.failure = new Error("closed");
    const sent = dispatchPower(f.connections, "kiosk", message, 25);
    if (mode === "replace") f.connections.set("kiosk", { ...f.connection, ws: new Socket() });
    if (mode === "close") f.socket.terminate();
    if (mode !== "timeout" && mode !== "throw") f.socket.callback!(mode === "callback" ? new Error("write failed") : undefined);
    assert.equal(await sent, false, mode);
  }
});

test("validation completing after timeout cannot send an obsolete command", async () => {
  const validation = deferred<boolean>();
  const f = fixture(() => validation.promise);
  assert.equal(await dispatchPower(f.connections, "kiosk", message, 10), false);
  validation.resolve(true);
  await tick();
  assert.deepEqual(f.socket.writes, []);
});

test("offline and unrelated command types fail closed", async () => {
  const f = fixture();
  assert.equal(await dispatchPower(f.connections, "other", message), false);
  assert.equal(await dispatchPower(f.connections, "kiosk", { type: "reboot" }), false);
  f.socket.terminate();
  assert.equal(await dispatchPower(f.connections, "kiosk", message), false);
  assert.deepEqual(f.socket.writes, []);
});
