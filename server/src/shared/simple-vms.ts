import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { uuidv7 } from "uuidv7";
import type { Repository } from "./db/repository.js";
import type { SecretsApi } from "./secrets.js";
import { withSimpleVmsSync } from "./simple-vms-access.js";
import { simpleVmsAddress, simpleVmsStreamUri, validateSimpleVmsSnapshot } from "./simple-vms-schema.js";

export interface SimpleVmsSource {
  id: string; instance_id: string; device_id: string; owner_kiosk_id: string | null;
  enabled: boolean; auto_sync: boolean; local_address: string; external_address: string | null;
  local_http_address: string | null; external_http_address: string | null;
  viewer_username: string; viewer_password_encrypted: string; ingest_key_hash: string;
  revision: string | number; last_sync_at: string | null;
}
export const simpleVmsTokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function simpleVmsTokenMatches(source: SimpleVmsSource, token: string): boolean {
  const expected = Buffer.from(source.ingest_key_hash, "hex");
  const actual = Buffer.from(simpleVmsTokenHash(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function getSimpleVmsSource(repo: Repository, id: string): Promise<SimpleVmsSource | undefined> {
  return repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE id = ?", [id]);
}
export interface SimpleVmsSummary extends SimpleVmsSource {
  name: string; camera_count: number; connected: boolean; use_local_address: boolean;
}
export async function listSimpleVmsSources(repo: Repository, kioskId = ""): Promise<SimpleVmsSummary[]> {
  return repo.adapter.all<SimpleVmsSummary>(`SELECT s.*, d.name,
    (SELECT count(*)::int FROM simple_vms_cameras c WHERE c.source_id = s.id) AS camera_count,
    (s.owner_kiosk_id = ? OR EXISTS (SELECT 1 FROM simple_vms_linked_kiosks k WHERE k.source_id = s.id AND k.kiosk_id = ?)) IS TRUE AS connected,
    (s.owner_kiosk_id = ? OR COALESCE((SELECT k.use_local_address FROM simple_vms_linked_kiosks k WHERE k.source_id = s.id AND k.kiosk_id = ?), false)) IS TRUE AS use_local_address
    FROM simple_vms_sources s JOIN camera_devices d ON d.id = s.device_id ORDER BY d.name, s.id`, [kioskId, kioskId, kioskId, kioskId]);
}
/** Source -> kiosk -> display lock order is shared by enrollment, removal and reconciliation. */
export async function lockSimpleVmsKiosks(repo: Repository, sourceId: string, extraIds: string[] = []): Promise<string[]> {
  const rows = await repo.adapter.all<{ id: string }>(`SELECT k.id FROM kiosks k WHERE
    ${extraIds.length ? `k.id IN (${extraIds.map(() => "?").join(",")}) OR ` : ""}
    k.id = (SELECT owner_kiosk_id FROM simple_vms_sources WHERE id = ?) OR
    EXISTS (SELECT 1 FROM simple_vms_linked_kiosks l WHERE l.source_id = ? AND l.kiosk_id = k.id) OR
    EXISTS (SELECT 1 FROM displays d JOIN display_layouts dl ON dl.display_id = d.id
      JOIN simple_vms_groups g ON g.layout_id = dl.layout_id WHERE d.kiosk_id = k.id AND g.source_id = ?)
    ORDER BY k.id FOR UPDATE OF k`, [...extraIds, sourceId, sourceId, sourceId]);
  return rows.map(row => row.id);
}
/** Remove BF's imported copies atomically; the native recorder and its recordings remain untouched. */
export async function removeSimpleVmsSource(repo: Repository, sourceId: string): Promise<string[]> {
  return withSimpleVmsSync(() => repo.transact(async () => {
    const source = await repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE id = ? FOR UPDATE", [sourceId]);
    if (!source) return [];
    await lockSimpleVmsKiosks(repo, source.id);
    const linked = await repo.adapter.all<{ kiosk_id: string }>("SELECT kiosk_id FROM simple_vms_linked_kiosks WHERE source_id = ?", [sourceId]);
    const groups = await repo.adapter.all<{ layout_id: string | null }>("SELECT layout_id FROM simple_vms_groups WHERE source_id = ?", [sourceId]);
    for (const group of groups) if (group.layout_id) await repo.deleteLayout(group.layout_id);
    const cameras = await repo.adapter.all<{ camera_id: string }>("SELECT camera_id FROM simple_vms_cameras WHERE source_id = ?", [sourceId]);
    for (const camera of cameras) await repo.deleteCamera(camera.camera_id);
    await repo.adapter.run("DELETE FROM simple_vms_sources WHERE id = ?", [sourceId]);
    await repo.deleteCameraDevice(source.device_id);
    const affected = [source.owner_kiosk_id, ...linked.map(kiosk => kiosk.kiosk_id)].filter((id): id is string => !!id);
    for (const id of affected) await refreshSimpleVmsKioskEnabled(repo, id);
    return affected;
  }));
}
export async function saveSimpleVmsSource(repo: Repository, secrets: SecretsApi, ownerId: string, input: {
  instanceId: string; name: string; localAddress: string; externalAddress: string; localHttpAddress?: string; externalHttpAddress?: string; linkedKioskIds: string[];
  enabled: boolean; autoSync: boolean; viewerUsername: string; viewerPassword: string; ingestToken: string;
}): Promise<SimpleVmsSource> {
  if (!input.instanceId || input.instanceId.length > 128 || !input.name || input.name.length > 255) throw new Error("Instance ID and NVR name are required");
  const local = simpleVmsAddress(input.localAddress);
  const external = input.externalAddress ? simpleVmsAddress(input.externalAddress, true) : null;
  const httpAddress = (value: string | undefined) => {
    if (!value) return null;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use an HTTP(S) plugin address without credentials or path");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Use HTTPS for a remote browser media address");
    return url.origin;
  };
  const localHttp = httpAddress(input.localHttpAddress);
  const externalHttp = httpAddress(input.externalHttpAddress);
  const linked = [...new Set(input.linkedKioskIds)].filter(id => id !== ownerId);
  if (linked.length && !external) throw new Error("Set an external SimpleVMS address before linking kiosks");
  for (const id of [ownerId, ...linked]) {
    const kiosk = await repo.getKioskById(id);
    if (!kiosk?.enabled || (id === ownerId && kiosk.capabilities.includes("android-viewer"))) throw new Error("Select an enabled recorder kiosk and enabled linked kiosks in this tenant");
  }
  return withSimpleVmsSync(() => repo.transact(async () => {
    const previous = await repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE owner_kiosk_id = ? FOR UPDATE", [ownerId]);
    if (previous && previous.instance_id !== input.instanceId) throw new Error("The connected SimpleVMS instance identity cannot be changed");
    if ((!previous || input.ingestToken) && (input.ingestToken.length < 32 || input.ingestToken.length > 256)) throw new Error("Use an integration token of 32–256 characters");
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(input.viewerUsername) || ((!previous || input.viewerPassword) && input.viewerPassword.length < 16) || input.viewerPassword.length > 512) throw new Error("Use a viewer username and a password of at least 16 characters");
    const id = previous?.id ?? uuidv7();
    const deviceId = previous?.device_id ?? uuidv7();
    await lockSimpleVmsKiosks(repo, id, [ownerId, ...linked]);
    if (!previous) {
      // Existing NVR hierarchy, with a provider-specific device type.
      await repo.adapter.run(`INSERT INTO camera_devices(id, name, type, host, port, discovery_runner)
        VALUES (?, ?, 'simplevms', ?, ?, ?)`, [deviceId, input.name, new URL(local).hostname, Number(new URL(local).port || 554), `kiosk:${ownerId}`]);
    }
    await repo.adapter.run(`INSERT INTO simple_vms_sources(id, instance_id, device_id, owner_kiosk_id, enabled, auto_sync,
      local_address, external_address, local_http_address, external_http_address, viewer_username, viewer_password_encrypted, ingest_key_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, auto_sync = excluded.auto_sync,
      local_address = excluded.local_address, external_address = excluded.external_address,
      local_http_address = excluded.local_http_address, external_http_address = excluded.external_http_address,
      viewer_username = excluded.viewer_username, viewer_password_encrypted = excluded.viewer_password_encrypted,
      ingest_key_hash = excluded.ingest_key_hash`, [id, input.instanceId, deviceId, ownerId, input.enabled, input.autoSync, local, external, localHttp, externalHttp,
      input.viewerUsername, input.viewerPassword ? secrets.encryptString(input.viewerPassword, "simple-vms-viewer") : previous!.viewer_password_encrypted,
      input.ingestToken ? simpleVmsTokenHash(input.ingestToken) : previous!.ingest_key_hash]);
    await repo.adapter.run("DELETE FROM simple_vms_linked_kiosks WHERE source_id = ?", [id]);
    for (const kioskId of linked) await repo.adapter.run("INSERT INTO simple_vms_linked_kiosks(source_id, kiosk_id) VALUES (?, ?)", [id, kioskId]);
    await repo.updateKiosk(ownerId, { simple_vms_enabled: input.enabled });
    await reconcileSimpleVmsAssignments(repo, id);
    return (await getSimpleVmsSource(repo, id))!;
  }));
}

export async function reconcileSimpleVmsAssignments(repo: Repository, sourceId?: string): Promise<void> {
  await withSimpleVmsSync(async () => {
    const sources = sourceId ? [await getSimpleVmsSource(repo, sourceId)].filter((s): s is SimpleVmsSource => !!s)
      : await repo.adapter.all<SimpleVmsSource>("SELECT * FROM simple_vms_sources");
    for (const candidate of sources) await repo.transact(async () => {
      const source = await repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE id = ? FOR UPDATE", [candidate.id]);
      if (!source) return;
      await lockSimpleVmsKiosks(repo, source.id);
      const layouts = await repo.adapter.all<{ layout_id: string }>("SELECT layout_id FROM simple_vms_groups WHERE source_id = ? AND layout_id IS NOT NULL", [source.id]);
      const eligible = new Set<string>();
      if (source.enabled) {
        if (source.owner_kiosk_id) eligible.add(source.owner_kiosk_id);
        for (const k of await repo.adapter.all<{ kiosk_id: string }>("SELECT kiosk_id FROM simple_vms_linked_kiosks WHERE source_id = ?", [source.id])) eligible.add(k.kiosk_id);
      }
      if (!layouts.length) return;
      const kioskIds = [...eligible];
      // Serialize default restoration with explicit display edits; use one global lock order across sources.
      await repo.adapter.all(`SELECT d.id FROM displays d WHERE ${kioskIds.length ? `d.kiosk_id IN (${kioskIds.map(() => "?").join(",")}) OR ` : ""}
        EXISTS (SELECT 1 FROM display_layouts dl JOIN simple_vms_groups g ON g.layout_id = dl.layout_id WHERE dl.display_id = d.id AND g.source_id = ?)
        ORDER BY d.id FOR UPDATE OF d`, [...kioskIds, source.id]);
      for (const { layout_id } of layouts) {
        for (const display of await repo.listDisplaysForLayout(layout_id)) {
          if (!display.kiosk_id || !eligible.has(display.kiosk_id)) {
            if (display.default_layout_id === layout_id) await repo.adapter.run(`INSERT INTO simple_vms_display_defaults(display_id, source_id, layout_id)
              VALUES (?, ?, ?) ON CONFLICT(display_id) DO UPDATE SET source_id = excluded.source_id, layout_id = excluded.layout_id`, [display.id, source.id, layout_id]);
            await repo.detachLayoutFromDisplay(display.id, layout_id);
          }
        }
        for (const kioskId of eligible) for (const display of await repo.listDisplaysForKiosk(kioskId)) {
          await repo.attachLayoutToDisplay(display.id, layout_id);
          const remembered = await repo.adapter.get("SELECT 1 FROM simple_vms_display_defaults WHERE display_id = ? AND source_id = ? AND layout_id = ?", [display.id, source.id, layout_id]);
          if (remembered) {
            // Preserve a different default chosen while the recorder was disconnected.
            await repo.adapter.run("UPDATE displays SET default_layout_id = ? WHERE id = ? AND default_layout_id IS NULL", [layout_id, display.id]);
            await repo.adapter.run("DELETE FROM simple_vms_display_defaults WHERE display_id = ? AND source_id = ? AND layout_id = ?", [display.id, source.id, layout_id]);
          }
        }
      }
    });
  });
}

export async function applySimpleVmsSnapshot(repo: Repository, sourceId: string, input: unknown): Promise<{ revision: number; applied: boolean }> {
  const snapshot = validateSimpleVmsSnapshot(input);
  return withSimpleVmsSync(() => repo.transact(async () => {
    const source = await repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE id = ? FOR UPDATE", [sourceId]);
    if (!source?.enabled || !source.auto_sync) throw new Error("SimpleVMS synchronization is disabled");
    if (source.instance_id !== snapshot.instanceId) throw new Error("SimpleVMS instance identity mismatch");
    if (snapshot.revision <= Number(source.revision)) return { revision: Number(source.revision), applied: false };
    await lockSimpleVmsKiosks(repo, sourceId);
    const cameraIds = new Map<string, string>();
    const previous = await repo.adapter.all<{ external_id: string; camera_id: string }>("SELECT external_id, camera_id FROM simple_vms_cameras WHERE source_id = ?", [sourceId]);
    // Free this source's names inside the transaction so swaps and replacements stay atomic.
    for (const old of previous) {
      const temporary = `simplevms-sync-${sourceId}-${old.camera_id}-${uuidv7()}`;
      await repo.updateCamera(old.camera_id, { name: temporary });
      const entity = await repo.getEntityForCamera(old.camera_id);
      if (entity) await repo.updateEntity(entity.id, { name: temporary });
    }
    for (const cam of snapshot.cameras) {
      let id = previous.find(p => p.external_id === cam.id)?.camera_id;
      let name = cam.name;
      if (await repo.getCameraByName(name)) name = `${snapshot.name} / ${cam.name}`;
      const qualified = `${snapshot.name} / ${cam.name} [${sourceId}/${cam.id}]`;
      let attempt = 0;
      while (await repo.getCameraByName(name)) name = qualified + (attempt++ ? ` (${attempt})` : "");
      if (!id) {
        const created = await repo.createCamera({ name, type: "rtsp", device_id: source.device_id, device_channel_id: cam.id });
        id = created.id;
        await repo.adapter.run("INSERT INTO simple_vms_cameras(source_id, external_id, camera_id) VALUES (?, ?, ?)", [sourceId, cam.id, id]);
      }
      cameraIds.set(cam.id, id);
      await repo.updateCamera(id, { name, enabled: cam.enabled, rtsp_url: null, event_source: "server", capabilities: [] });
      const entity = await repo.getEntityForCamera(id);
      if (entity) {
        let entityName = name;
        let conflict = await repo.getEntityByName(entityName);
        let suffix = 0;
        while (conflict && conflict.id !== entity.id) {
          entityName = `${name} (cam ${id}${suffix++ ? `-${suffix}` : ""})`;
          conflict = await repo.getEntityByName(entityName);
        }
        await repo.updateEntity(entity.id, { name: entityName });
      }
      await repo.deleteCameraStreams(id);
      for (const profile of cam.profiles) await repo.createCameraStream({
        camera_id: id, role: profile.role, name: profile.name, profile_token: profile.id,
        rtsp_uri: simpleVmsStreamUri(source.local_address, cam.id, profile.id),
        width: profile.width || null, height: profile.height || null, encoding: profile.codec, framerate: Math.round(profile.fps) || null, is_discovered: true,
      });
    }
    // Use the existing deletion path, including custom layout/entity cleanup.
    for (const old of previous) if (!cameraIds.has(old.external_id)) await repo.deleteCamera(old.camera_id);
    const groups = await repo.adapter.all<{ external_id: string; layout_id: string | null }>("SELECT external_id, layout_id FROM simple_vms_groups WHERE source_id = ?", [sourceId]);
    // Free existing labels before resolving swaps or names from deleted groups.
    for (const old of groups) if (old.layout_id) await repo.updateLayout(old.layout_id, { name: `simplevms-group-sync-${sourceId}-${old.layout_id}-${uuidv7()}` });
    const keep = new Set<string>();
    for (const group of snapshot.groups) {
      if (!group.cameraIds.length) continue;
      keep.add(group.id);
      let layoutId = groups.find(g => g.external_id === group.id)?.layout_id;
      let name = `${snapshot.name} / ${group.name}`;
      const qualified = `${name} (${sourceId}-${group.id})`;
      let attempt = 0;
      while (true) {
        const conflict = await repo.adapter.get<{ id: string }>("SELECT id FROM layouts WHERE name = ?", [name]);
        if (!conflict || conflict.id === layoutId) break;
        name = qualified + (attempt++ ? ` (${attempt})` : "");
      }
      if (!layoutId) {
        layoutId = (await repo.createLayout({ name, description: "Managed by SimpleVMS" })).id;
        await repo.adapter.run("INSERT INTO simple_vms_groups(source_id, external_id, layout_id) VALUES (?, ?, ?) ON CONFLICT(source_id, external_id) DO UPDATE SET layout_id = excluded.layout_id", [sourceId, group.id, layoutId]);
      } else {
        await repo.updateLayout(layoutId, { name });
      }
      const cells = await repo.listLayoutCells(layoutId);
      const members = new Set(group.cameraIds.map(externalId => cameraIds.get(externalId)!));
      for (const cell of cells) if (!cell.camera_id || !members.has(cell.camera_id)) await repo.deleteLayoutCell(cell.id);
      const columns = Math.ceil(Math.sqrt(group.cameraIds.length));
      for (const [index, externalId] of group.cameraIds.entries()) {
        const cameraId = cameraIds.get(externalId)!;
        const existing = cells.find(cell => cell.camera_id === cameraId);
        if (existing) {
          await repo.updateLayoutCell(existing.id, { row: Math.floor(index / columns), col: index % columns });
          continue;
        }
        const entity = await repo.adapter.get<{ id: string }>("SELECT id FROM entities WHERE camera_id = ?", [cameraId]);
        await repo.createLayoutCell({ layout_id: layoutId, row: Math.floor(index / columns), col: index % columns,
          content_type: "camera", camera_id: cameraId, entity_id: entity?.id ?? null });
      }
    }
    for (const old of groups) if (!keep.has(old.external_id)) {
      if (old.layout_id) await repo.deleteLayout(old.layout_id);
      await repo.adapter.run("DELETE FROM simple_vms_groups WHERE source_id = ? AND external_id = ?", [sourceId, old.external_id]);
    }
    await repo.adapter.run("UPDATE camera_devices SET name = ? WHERE id = ?", [snapshot.name, source.device_id]);
    await repo.adapter.run("UPDATE simple_vms_sources SET revision = ?, last_sync_at = now() WHERE id = ?", [snapshot.revision, sourceId]);
    await reconcileSimpleVmsAssignments(repo, sourceId);
    return { revision: snapshot.revision, applied: true };
  }));
}

/** Catalog presence is independent of whether a camera currently has a tile. */
export async function simpleVmsCamerasForKiosk(repo: Repository, kioskId: string) {
  return repo.adapter.all<{ camera_id: string; external_id: string; source_id: string; local_address: string; external_address: string | null; local_http_address: string | null; external_http_address: string | null;
    owner_kiosk_id: string | null; use_local_address: boolean; viewer_username: string; viewer_password_encrypted: string }>(`SELECT c.*, s.local_address, s.external_address, s.local_http_address, s.external_http_address,
      (s.owner_kiosk_id = ? OR COALESCE((SELECT k.use_local_address FROM simple_vms_linked_kiosks k WHERE k.source_id = s.id AND k.kiosk_id = ?), false)) IS TRUE AS use_local_address,
      s.owner_kiosk_id, s.viewer_username, s.viewer_password_encrypted FROM simple_vms_cameras c JOIN simple_vms_sources s ON s.id = c.source_id
      WHERE s.enabled = true AND (s.owner_kiosk_id = ? OR EXISTS
        (SELECT 1 FROM simple_vms_linked_kiosks k WHERE k.source_id = s.id AND k.kiosk_id = ?))`, [kioskId, kioskId, kioskId, kioskId]);
}

export async function refreshSimpleVmsKioskEnabled(repo: Repository, kioskId: string): Promise<void> {
  const active = await repo.adapter.get(`SELECT 1 FROM simple_vms_sources s WHERE s.enabled = true AND
    (s.owner_kiosk_id = ? OR EXISTS (SELECT 1 FROM simple_vms_linked_kiosks k WHERE k.source_id = s.id AND k.kiosk_id = ?))`, [kioskId, kioskId]);
  await repo.updateKiosk(kioskId, { simple_vms_enabled: !!active });
}

export async function linkSimpleVmsKiosk(repo: Repository, sourceId: string, kioskId: string, linked: boolean, local = false): Promise<void> {
  await withSimpleVmsSync(() => repo.transact(async () => {
    const source = await repo.adapter.get<SimpleVmsSource>("SELECT * FROM simple_vms_sources WHERE id = ? FOR UPDATE", [sourceId]);
    if (!source) throw new Error("SimpleVMS instance not found");
    await lockSimpleVmsKiosks(repo, sourceId, [kioskId]);
    const kiosk = await repo.getKioskById(kioskId);
    if (!kiosk || (linked && !kiosk.enabled)) throw new Error("Select an available SimpleVMS instance and enabled kiosk");
    if (linked) {
      if (!source.enabled) throw new Error("Enable this SimpleVMS instance before linking a kiosk");
      if (local && kiosk.capabilities.includes("android-viewer")) throw new Error("Android viewers require a reachable recorder address");
      if (!local && !source.external_address) throw new Error("This recorder needs a reachable media address; use local access only when SimpleVMS runs on this kiosk");
      await repo.adapter.run(`INSERT INTO simple_vms_linked_kiosks(source_id, kiosk_id, use_local_address) VALUES (?, ?, ?)
        ON CONFLICT(source_id, kiosk_id) DO UPDATE SET use_local_address = excluded.use_local_address`, [sourceId, kioskId, local]);
    } else {
      await repo.adapter.run("DELETE FROM simple_vms_linked_kiosks WHERE source_id = ? AND kiosk_id = ?", [sourceId, kioskId]);
      if (source.owner_kiosk_id === kioskId) await repo.adapter.run("UPDATE simple_vms_sources SET owner_kiosk_id = NULL WHERE id = ?", [sourceId]);
    }
    await refreshSimpleVmsKioskEnabled(repo, kioskId);
    await reconcileSimpleVmsAssignments(repo, sourceId);
  }));
}

/** Each kiosk gets its own reader credential; SimpleVMS checks current link authorization. */
export function simpleVmsViewerCredentials(username: string, password: string, kioskId: string, cameraId: string) {
  const scope = `${kioskId}/${cameraId}`;
  return { username: `${username}/${scope}`, password: createHmac("sha256", password).update(scope).digest("base64url") };
}
