import type { Repository } from "./db/repository.js";
import type { BundleCamera, BundleDisplayWithLayouts } from "./bundle.js";

export interface CatalogOrigin { provider: string; source_id: string; instance_id: string; external_id: string }
export interface CatalogMetadata {
  camera_origins: Record<string, CatalogOrigin>;
  groups: Array<{ id: string; name: string; layout_id: string; camera_ids: string[]; origin: CatalogOrigin }>;
}

/** Only IDs and names scoped to this bundle. Never serialize source credentials. */
export async function kioskCatalogMetadata(repo: Repository, cameras: BundleCamera[], displays: BundleDisplayWithLayouts[], sourceIds: string[]): Promise<CatalogMetadata> {
  const result: CatalogMetadata = { camera_origins: {}, groups: [] };
  if (!sourceIds.length) return result;
  const allowedCameras = new Set(cameras.map(c => c.id));
  const layouts = new Map(displays.flatMap(d => d.layouts).map(l => [l.id, l]));
  for (const sourceId of [...new Set(sourceIds)].sort()) {
    const source = await repo.adapter.get<{ instance_id: string }>("SELECT instance_id FROM simple_vms_sources WHERE id = ? AND enabled = true", [sourceId]);
    if (!source) continue;
    const origin = (external_id: string): CatalogOrigin => ({ provider: "simplevms", source_id: sourceId, instance_id: source.instance_id, external_id });
    const mapped = await repo.adapter.all<{ camera_id: string; external_id: string }>("SELECT camera_id, external_id FROM simple_vms_cameras WHERE source_id = ? ORDER BY camera_id", [sourceId]);
    for (const camera of mapped) if (allowedCameras.has(camera.camera_id)) result.camera_origins[camera.camera_id] = origin(camera.external_id);
    const groups = await repo.adapter.all<{ external_id: string; layout_id: string | null }>("SELECT external_id, layout_id FROM simple_vms_groups WHERE source_id = ? ORDER BY external_id", [sourceId]);
    for (const group of groups) {
      const layout = group.layout_id ? layouts.get(group.layout_id) : undefined;
      if (!layout) continue;
      result.groups.push({ id: `simplevms:${sourceId}:${group.external_id}`, name: layout.name, layout_id: layout.id,
        camera_ids: [...new Set(layout.cells.flatMap(c => c.camera_id && allowedCameras.has(c.camera_id) ? [c.camera_id] : []))].sort(), origin: origin(group.external_id) });
    }
  }
  return result;
}
