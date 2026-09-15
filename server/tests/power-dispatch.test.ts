import assert from "node:assert/strict";
import test from "node:test";
import { dispatchPower, acceptPowerResult } from "../src/shared/power-dispatch.js";
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

test("Android power dispatch waits for validation, socket callback and accepted ACK", async () => {
  const validation = deferred<boolean>();
  const f = fixture(() => validation.promise);
  let resolved = false;
  let cancelled = false;
  const ack = deferred<boolean>();
  const sent = dispatchPower(f.connections, "kiosk", message, 5_000, (_connection, requestId) => {
    assert.match(requestId, /^[a-f0-9-]{36}$/);
    return { result: ack.promise, cancel: () => { cancelled = true; } };
  }).then((value) => { resolved = true; return value; });
  assert.deepEqual(f.socket.writes, []);
  validation.resolve(true);
  await tick();
  const payload = JSON.parse(f.socket.writes[0]!);
  assert.deepEqual({ type: payload.type, display_id: payload.display_id }, message);
  assert.match(payload.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(resolved, false);
  f.socket.callback!();
  assert.equal(resolved, false);
  ack.resolve(true);
  assert.equal(await sent, true);
  assert.equal(cancelled, true);
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


test("Android rejected, missing, stale and premature ACKs cannot falsely confirm power", async () => {
  for (const mode of ["rejected", "timeout", "replace", "write-error", "early-success"]) {
    const f = fixture(async () => true);
    const ack = deferred<boolean>();
    let cancelled = false;
    const sent = dispatchPower(f.connections, "kiosk", message, mode === "timeout" ? 30 : 1_000, () => ({ result: ack.promise, cancel: () => { cancelled = true; } }));
    await tick();
    if (mode === "replace") f.connections.set("kiosk", { ...f.connection, ws: new Socket() });
    if (mode !== "timeout") ack.resolve(mode !== "rejected");
    await tick(); // ACK may arrive before the transport completion callback.
    f.socket.callback!(mode === "write-error" ? new Error("write failed") : undefined);
    assert.equal(await sent, mode === "early-success", mode);
    assert.equal(cancelled, true, mode);
  }
});

test("ACK routing checks type, kiosk, exact socket, boolean acceptance and one-time request ownership", () => {
  const socket = new Socket();
  const received: unknown[] = [];
  const timer = setTimeout(() => {}, 1_000);
  const pending = new Map([["request", { kioskId: "kiosk", socket, responseType: "power-result", timer, resolve: (value: unknown) => received.push(value) }]]);
  try {
    const ack = { type: "power-result", request_id: "request", accepted: true };
    assert.equal(acceptPowerResult(pending, "other", socket, ack), false);
    assert.equal(acceptPowerResult(pending, "kiosk", new Socket(), ack), false);
    for (const malformed of [{ ...ack, accepted: "true" }, { ...ack, request_id: "stale" }, { ...ack, type: "pong" }]) {
      assert.equal(acceptPowerResult(pending, "kiosk", socket, malformed), false);
    }
    assert.equal(pending.size, 1);
    assert.deepEqual(received, []);
    assert.equal(acceptPowerResult(pending, "kiosk", socket, { ...ack, accepted: false }), true);
    assert.deepEqual(received, [false]);
    assert.equal(pending.size, 0);
    assert.equal(acceptPowerResult(pending, "kiosk", socket, ack), false);
  } finally { clearTimeout(timer); }
});


test("only one Android power request owns a socket until validation and confirmation finish", async () => {
  const validation = deferred<boolean>();
  const f = fixture(() => validation.promise);
  const first = dispatchPower(f.connections, "kiosk", message, 1_000);
  assert.equal(await dispatchPower(f.connections, "kiosk", { type: "wake" }), false);
  validation.resolve(false);
  assert.equal(await first, false);
  f.connection.validateViewerPower = async () => true;
  const ack = deferred<boolean>();
  const next = dispatchPower(f.connections, "kiosk", message, 1_000, () => ({ result: ack.promise, cancel() {} }));
  await tick();
  ack.resolve(true);
  await tick();
  assert.equal(await dispatchPower(f.connections, "kiosk", { type: "wake" }), false, "Early ACK still waits for the write callback");
  f.socket.callback!();
  assert.equal(await next, true);
});
