import { AsyncLocalStorage } from "node:async_hooks";
import type { DbAdapter } from "./db/db-adapter.js";

const synchronization = new AsyncLocalStorage<boolean>();
export function withSimpleVmsSync<T>(fn: () => Promise<T>): Promise<T> {
  return synchronization.run(true, fn);
}

/** Enforced below the HTTP layer, including API and Node-RED writes. */
export async function assertSimpleVmsWritable(db: DbAdapter, kind: "camera" | "device" | "layout" | "cell" | "entity", id: string): Promise<void> {
  if (synchronization.getStore()) return;
  const queries = {
    camera: "SELECT 1 FROM simple_vms_cameras WHERE camera_id = ?",
    device: "SELECT 1 FROM simple_vms_sources WHERE device_id = ?",
    layout: "SELECT 1 FROM simple_vms_groups WHERE layout_id = ?",
    cell: "SELECT 1 FROM layout_cells c JOIN simple_vms_groups g ON g.layout_id = c.layout_id WHERE c.id = ?",
    entity: "SELECT 1 FROM entities e JOIN simple_vms_cameras c ON c.camera_id = e.camera_id WHERE e.id = ?",
  };
  if (await db.get(queries[kind], [id])) throw Object.assign(new Error("This resource is managed by SimpleVMS; edit it in SimpleVMS"), { status: 409, statusCode: 409 });
}

export async function simpleVmsLayoutAllowed(db: DbAdapter, layoutId: string, kioskId: string): Promise<boolean> {
  const managed = await db.get<{ source_id: string }>("SELECT source_id FROM simple_vms_groups WHERE layout_id = ?", [layoutId]);
  if (!managed) return true;
  return !!await db.get(`SELECT 1 FROM simple_vms_sources s WHERE s.id = ? AND s.enabled = true
    AND (s.owner_kiosk_id = ? OR EXISTS (SELECT 1 FROM simple_vms_linked_kiosks k WHERE k.source_id = s.id AND k.kiosk_id = ?))`, [managed.source_id, kioskId, kioskId]);
}
