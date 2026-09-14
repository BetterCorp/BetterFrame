import { AsyncLocalStorage } from "node:async_hooks";

export interface PowerSample { sessionId: string; revision: number }
const sessions = new Map<string, PowerSample & { owner: object }>();
const mutations = new Map<string, Promise<void>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

export function readPowerSample(value: Record<string, unknown>): PowerSample | null {
  const sessionId = value["power_session_id"];
  const revision = value["power_revision"];
  return typeof sessionId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId)
    && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0
    ? { sessionId, revision } : null;
}

export function bindPowerSession(kioskId: string, owner: object, sample: PowerSample | null): void {
  const previous = sessions.get(kioskId);
  if (!sample) { sessions.delete(kioskId); return; }
  sessions.set(kioskId, { ...sample, owner,
    revision: previous?.sessionId === sample.sessionId ? Math.max(previous.revision, sample.revision) : sample.revision });
}
export function unbindPowerSession(kioskId: string, owner: object): void {
  if (sessions.get(kioskId)?.owner === owner) sessions.delete(kioskId);
}
export function hasPowerSession(kioskId: string): boolean { return sessions.has(kioskId); }
export function ownsPowerSession(kioskId: string, owner: object): boolean {
  return sessions.get(kioskId)?.owner === owner;
}
export function powerSampleAllowed(kioskId: string, sample: PowerSample | null): boolean {
  const current = sessions.get(kioskId);
  return Boolean(sample && current && current.sessionId === sample.sessionId && sample.revision >= current.revision);
}
export function advancePowerSample(kioskId: string, sample: PowerSample): void {
  const current = sessions.get(kioskId);
  if (current && powerSampleAllowed(kioskId, sample)) current.revision = sample.revision;
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
