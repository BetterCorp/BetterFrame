import { AsyncLocalStorage } from "node:async_hooks";

export interface PowerSample { sessionId: string; revision: number }
interface PowerSession extends PowerSample {
  owner?: object;
  expiresAt: number;
  retired: Map<string, number>;
}
const HISTORY_MS = 30 * 60_000;
const MAX_OWNERLESS = 4096;
const MAX_RETIRED = 8;
const sessions = new Map<string, PowerSession>();
const mutations = new Map<string, Promise<void>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();
let nextSweep = 0;

function prune(now: number, capacityMayIncrease = false): void {
  if (now < nextSweep && !capacityMayIncrease) return;
  nextSweep = now + 60_000;
  const ownerless: Array<[string, PowerSession]> = [];
  for (const [id, value] of sessions) {
    if (value.owner) continue;
    if (value.expiresAt <= now) sessions.delete(id);
    else ownerless.push([id, value]);
  }
  if (ownerless.length > MAX_OWNERLESS) {
    ownerless.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [id] of ownerless.slice(0, ownerless.length - MAX_OWNERLESS)) sessions.delete(id);
  }
}
function currentSession(kioskId: string, now: number): PowerSession | undefined {
  const current = sessions.get(kioskId);
  if (current && !current.owner && current.expiresAt <= now) {
    sessions.delete(kioskId);
    return undefined;
  }
  return current;
}
function replaceSession(kioskId: string, sample: PowerSample, owner: object | undefined, now: number): void {
  const previous = currentSession(kioskId, now);
  const retired = new Map([...(previous?.retired ?? [])].filter(([id, expires]) => id !== sample.sessionId && expires > now));
  if (previous && previous.sessionId !== sample.sessionId) retired.set(previous.sessionId, now + HISTORY_MS);
  while (retired.size > MAX_RETIRED) retired.delete(retired.keys().next().value!);
  sessions.set(kioskId, { ...sample, ...(owner ? { owner } : {}), expiresAt: now + HISTORY_MS, retired,
    revision: previous?.sessionId === sample.sessionId ? Math.max(previous.revision, sample.revision) : sample.revision });
  prune(now, !owner && (!previous || Boolean(previous.owner)));
}

export function readPowerSample(value: Record<string, unknown>): PowerSample | null {
  const sessionId = value["power_session_id"];
  const revision = value["power_revision"];
  return typeof sessionId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId)
    && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0
    ? { sessionId, revision } : null;
}

export function bindPowerSession(kioskId: string, owner: object, sample: PowerSample | null): void {
  const now = Date.now();
  if (!sample) {
    const previous = currentSession(kioskId, now);
    const wasOwned = Boolean(previous?.owner);
    if (previous) { delete previous.owner; previous.expiresAt = now + HISTORY_MS; }
    prune(now, wasOwned);
    return;
  }
  replaceSession(kioskId, sample, owner, now);
}
export function unbindPowerSession(kioskId: string, owner: object): void {
  const current = sessions.get(kioskId);
  if (current?.owner === owner) {
    delete current.owner;
    current.expiresAt = Date.now() + HISTORY_MS;
    prune(Date.now(), true);
  }
}
export function hasPowerSession(kioskId: string): boolean { return Boolean(currentSession(kioskId, Date.now())); }
export function ownsPowerSession(kioskId: string, owner: object): boolean {
  return sessions.get(kioskId)?.owner === owner;
}
export function powerSampleAllowed(kioskId: string, sample: PowerSample | null, now = Date.now()): boolean {
  const current = currentSession(kioskId, now);
  return Boolean(sample && current && current.sessionId === sample.sessionId && sample.revision >= current.revision);
}

/** HTTP can establish an offline baseline, but cannot replace a live socket or a retired process. */
export function heartbeatPowerSampleAllowed(kioskId: string, sample: PowerSample | null, now = Date.now()): boolean {
  if (!sample) return false;
  const current = currentSession(kioskId, now);
  if (current?.sessionId === sample.sessionId) return sample.revision >= current.revision;
  if (current?.owner || (current?.retired.get(sample.sessionId) ?? 0) > now) return false;
  // The first successful DB write advances this baseline to the sampled revision.
  replaceSession(kioskId, { ...sample, revision: -1 }, undefined, now);
  return true;
}
export function advancePowerSample(kioskId: string, sample: PowerSample, now = Date.now()): void {
  const current = currentSession(kioskId, now);
  if (current && powerSampleAllowed(kioskId, sample, now)) {
    current.revision = sample.revision;
    current.expiresAt = now + HISTORY_MS;
  }
}

/** Same-process ordering, matching the coordinator registry/socket ownership boundary. */
export async function withPowerStateLock<T>(kioskId: string, work: () => Promise<T>): Promise<T> {
  const current = held.getStore();
  if (current?.has(kioskId)) return work();
  const previous = mutations.get(kioskId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  mutations.set(kioskId, next);
  await previous;
  try { return await held.run(new Set([...(current ?? []), kioskId]), work); }
  finally {
    release();
    if (mutations.get(kioskId) === next) mutations.delete(kioskId);
  }
}
