import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Pool } from "pg";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("adapter close waits for actual client shutdown after pool.end resolves", async () => {
  const adapter = new PgAdapter("postgres://unused/unused");
  const pool = Reflect.get(adapter, "pool") as Pool;
  const originalEnd = pool.end.bind(pool);
  // Model pg-pool's real ordering: pool.end resolves while client.end remains pending.
  Object.defineProperty(pool, "end", { configurable: true, value: async () => {} });
  const first = new EventEmitter();
  const second = new EventEmitter();
  const alreadyClosed = new EventEmitter();
  pool.emit("connect", first);
  pool.emit("connect", second);
  pool.emit("connect", alreadyClosed);
  alreadyClosed.emit("end");
  try {
    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    await tick();
    assert.equal(closed, false);
    first.emit("end");
    await tick();
    assert.equal(closed, false, "Every remaining socket must close");
    second.emit("end");
    await closing;
    assert.equal(closed, true);
  } finally {
    first.emit("end");
    second.emit("end");
    await originalEnd();
  }
});

test("adapter close includes a client connected while the pool is draining", async () => {
  const adapter = new PgAdapter("postgres://unused/unused");
  const pool = Reflect.get(adapter, "pool") as Pool;
  const originalEnd = pool.end.bind(pool);
  let drained!: () => void;
  Object.defineProperty(pool, "end", { configurable: true, value: () => new Promise<void>((resolve) => { drained = resolve; }) });
  const client = new EventEmitter();
  try {
    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    pool.emit("connect", client);
    drained();
    await tick();
    assert.equal(closed, false);
    client.emit("end");
    await closing;
    assert.equal(closed, true);
  } finally {
    client.emit("end");
    await originalEnd();
  }
});
