import { createError } from "h3";
import type { AdminDeps } from "../../plugins/service-admin-http/index.js";
import type { Repository } from "../db/repository.js";
import type { Tenant } from "../types.js";
import {
  OWNED_RESOURCE_TABLES,
  ownershipPredicate,
  type OwnedResource,
  type ResourceOwner,
} from "../db/resource-ownership.js";
import { assertBpIdentity, type BpIdentity } from "./bp-tenants.js";

const reads = {
  getCameraById: "cameras",
  getCameraDeviceById: "camera_devices",
  getKioskById: "kiosks",
  getDisplayById: "displays",
  getLayoutById: "layouts",
  getEntityById: "entities",
  getLabelById: "labels",
  getIoBoxById: "ioboxes",
  getCloudAccount: "cloud_accounts",
} as const;
const lists = {
  listCameras: "cameras",
  listCameraDevices: "camera_devices",
  listKiosks: "kiosks",
  listDisplays: "displays",
  listLayouts: "layouts",
  listEntities: "entities",
  listLabels: "labels",
  listIoBoxes: "ioboxes",
  listCloudAccounts: "cloud_accounts",
  listFirmwareReleases: "firmware_releases",
  listOsUpdateReleases: "os_update_releases",
  listAbleSignAccounts: "ablesign_accounts",
} as const;
const creates = {
  createCamera: "cameras",
  createCameraDevice: "camera_devices",
  createKiosk: "kiosks",
  createLayout: "layouts",
  createEntity: "entities",
  createLabel: "labels",
  createCloudAccount: "cloud_accounts",
} as const;
const writes = {
  updateCamera: "cameras",
  deleteCamera: "cameras",
  updateCameraDevice: "camera_devices",
  deleteCameraDevice: "camera_devices",
  updateKiosk: "kiosks",
  updateDisplay: "displays",
  updateLayout: "layouts",
  deleteLayout: "layouts",
  updateEntity: "entities",
  deleteEntity: "entities",
  updateLabel: "labels",
  deleteLabel: "labels",
  updateIoBox: "ioboxes",
  updateCloudAccount: "cloud_accounts",
  deleteCloudAccount: "cloud_accounts",
} as const;
const relationships = {
  attachCameraLabel: ["cameras", "labels"],
  detachCameraLabel: ["cameras", "labels"],
  attachCameraDeviceLabel: ["camera_devices", "labels"],
  detachCameraDeviceLabel: ["camera_devices", "labels"],
  attachKioskLabel: ["kiosks", "labels"],
  detachKioskLabel: ["kiosks", "labels"],
  attachLayoutToDisplay: ["displays", "layouts"],
  detachLayoutFromDisplay: ["displays", "layouts"],
} as const;
const referenceFields: Record<string, OwnedResource> = {
  camera_id: "cameras",
  device_id: "camera_devices",
  cloud_account_id: "cloud_accounts",
  kiosk_id: "kiosks",
  entity_id: "entities",
  layout_id: "layouts",
  default_layout_id: "layouts",
  active_layout_id: "layouts",
};
const missing = () =>
  createError({ statusCode: 404, statusMessage: "Resource not found" });
export const isBpAdmin = (ctx: BpIdentity): boolean =>
  ctx.user?.roles.includes("admin") === true;
export function requireBpAdmin(ctx: BpIdentity): void {
  if (!isBpAdmin(ctx))
    throw createError({
      statusCode: 403,
      statusMessage: "Tenant administrator required",
    });
}

/** Single BP data boundary. Unregistered repository capabilities fail closed. */
export async function withBpUserAccess<T>(
  deps: AdminDeps,
  ctx: BpIdentity,
  tenant: Tenant,
  enabled: boolean,
  operation: (deps: AdminDeps) => Promise<T>,
): Promise<T> {
  assertBpIdentity(ctx);
  const raw = deps.repo;
  const actor: ResourceOwner = {
    issuer: ctx.user!.iss,
    subject: ctx.user!.sub,
  };
  const admin = isBpAdmin(ctx);
  const scope = enabled && !admin ? actor : undefined;
  const call = (name: string, args: unknown[]) =>
    Reflect.apply(
      (raw as unknown as Record<string, Function>)[name]!,
      raw,
      args,
    );
  const access = async (
    table: OwnedResource,
    id: unknown,
  ): Promise<boolean> => {
    if (typeof id !== "string" || !id) return false;
    const filter = ownershipPredicate(table, "bp_resource", scope);
    // A row lock also fences deletion while delivering a device command.
    const row = await raw.adapter.get(
      `SELECT 1 FROM ${table} bp_resource WHERE id = ? AND ${filter.sql}${table === "entities" && !admin ? " AND type <> 'dashboard'" : ""} FOR SHARE`,
      [id, ...filter.params],
    );
    return !!row;
  };
  const requireResource = async (table: OwnedResource, id: unknown) => {
    if (!(await access(table, id))) throw missing();
  };
  const ownerOf = async (
    table: OwnedResource,
    id: string,
  ): Promise<ResourceOwner | undefined> => {
    if (table === "displays") {
      const item = await raw.getDisplayById(id);
      if (item?.kiosk_id) return ownerOf("kiosks", item.kiosk_id);
    } else if (table === "cameras") {
      const item = await raw.adapter.get<{
        cloud_account_id: string | null;
        device_id: string | null;
      }>("SELECT cloud_account_id,device_id FROM cameras WHERE id = ?", [id]);
      if (item?.cloud_account_id)
        return ownerOf("cloud_accounts", item.cloud_account_id);
      if (item?.device_id) return ownerOf("camera_devices", item.device_id);
    } else if (table === "entities") {
      const item = await raw.getEntityById(id);
      if (item?.type === "camera" && item.camera_id)
        return ownerOf("cameras", item.camera_id);
    }
    return raw.adapter.get<ResourceOwner>(
      "SELECT owner_issuer AS issuer,owner_subject AS subject FROM bp_resource_owners WHERE resource_type = ? AND resource_id = ?",
      [table, id],
    );
  };
  const claim = async (
    table: OwnedResource,
    id: string,
    owner: ResourceOwner = actor,
  ) => {
    await raw.adapter.run(
      "INSERT INTO bp_resource_owners(resource_type,resource_id,owner_issuer,owner_subject) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      [table, id, owner.issuer, owner.subject],
    );
    const existing = await ownerOf(table, id);
    if (
      !existing ||
      existing.issuer !== owner.issuer ||
      existing.subject !== owner.subject
    )
      throw missing();
  };
  const sameOwner = async (
    left: OwnedResource,
    leftId: string,
    right: OwnedResource,
    rightId: string,
  ) => {
    await requireResource(left, leftId);
    await requireResource(right, rightId);
    if (!enabled) return;
    const [a, b] = await Promise.all([
      ownerOf(left, leftId),
      ownerOf(right, rightId),
    ]);
    if (a?.issuer !== b?.issuer || a?.subject !== b?.subject)
      throw createError({
        statusCode: 409,
        statusMessage: "Related resources must have the same owner",
      });
  };
  const references = async (
    body: unknown,
    source?: [OwnedResource, string],
  ) => {
    if (!body || typeof body !== "object") return;
    const values = body as Record<string, unknown>;
    if (!admin && (values.type === "dashboard" || values.dashboard_id))
      requireBpAdmin(ctx);
    for (const [key, table] of Object.entries(referenceFields)) {
      const id = values[key];
      if (typeof id === "string" && id) {
        await requireResource(table, id);
        if (source) await sameOwner(...source, table, id);
      }
    }
    if (Array.isArray(values.preload_camera_ids))
      for (const id of values.preload_camera_ids) {
        await requireResource("cameras", id);
        if (source) await sameOwner(...source, "cameras", String(id));
      }
  };
  const checkCell = async (id: string) => {
    const cell = await raw.getLayoutCellById(id);
    if (!cell) throw missing();
    await requireResource("layouts", cell.layout_id);
    if (!admin) await references(cell, ["layouts", cell.layout_id]);
    return cell;
  };
  // Pairing needs only its validated current tenant, never arbitrary SQL or another schema.
  const adapter = new Proxy(raw.adapter, {
    get(target, key) {
      if (key === "transaction" || key === "afterCommit" || key === "dialect")
        return (target[key] as Function)?.bind(target);
      if (key === "withSearchPath")
        return (schema: string, fn: () => Promise<unknown>) => {
          if (schema !== tenant.schema_name) throw missing();
          return target.withSearchPath(schema, fn);
        };
      if (key === "get")
        return (sql: string) => {
          if (
            sql !==
            "SELECT id,slug,schema_name FROM public.tenants WHERE schema_name = current_schema()"
          )
            throw new Error("Raw BP database access is not allowed");
          return target.get(sql);
        };
      throw new Error(`BP database capability is not allowed: ${String(key)}`);
    },
  });
  const repo = new Proxy(raw, {
    get(_target, property) {
      const name = String(property);
      if (name === "then") return undefined;
      if (name === "adapter") return adapter;
      return async (...args: unknown[]) => {
        if (name === "transact")
          return raw.transact(args[0] as () => Promise<unknown>);
        if (name === "insertAudit") {
          const entry = args[0] as {
            actor_id: string;
            metadata: Record<string, unknown>;
          };
          if (
            entry.actor_id !== actor.subject ||
            entry.metadata.bp_issuer !== actor.issuer
          )
            throw missing();
          return call(name, args);
        }
        const readTable = (reads as Record<string, OwnedResource>)[name];
        if (readTable)
          return (await access(readTable, args[0])) ? call(name, args) : null;
        const listTable = (lists as Record<string, OwnedResource>)[name];
        if (listTable) {
          const rows = await call(name, [scope]);
          return name === "listEntities" && !admin
            ? rows.filter((row: { type: string }) => row.type !== "dashboard")
            : rows;
        }
        const createTable = (creates as Record<string, OwnedResource>)[name];
        if (createTable) {
          await references(args[0]);
          const item = await call(name, args);
          await claim(
            createTable,
            item.id,
            (await ownerOf(createTable, item.id)) ?? actor,
          );
          return item;
        }
        const writeTable = (writes as Record<string, OwnedResource>)[name];
        if (writeTable) {
          await requireResource(writeTable, args[0]);
          await references(args[1], [writeTable, String(args[0])]);
          return call(name, args);
        }
        const pair = (
          relationships as Record<
            string,
            readonly [OwnedResource, OwnedResource]
          >
        )[name];
        if (pair) {
          await sameOwner(pair[0], String(args[0]), pair[1], String(args[1]));
          return call(name, args);
        }
        if (
          name === "listLayoutsForDisplay" ||
          name === "listDisplaysForKiosk"
        ) {
          await requireResource(
            name === "listLayoutsForDisplay" ? "displays" : "kiosks",
            args[0],
          );
          const table =
            name === "listLayoutsForDisplay" ? "layouts" : "displays";
          const rows = await call(name, args);
          const flags = await Promise.all(
            rows.map((row: { id: string }) => access(table, row.id)),
          );
          return rows.filter((_row: unknown, i: number) => flags[i]);
        }
        if (name === "getLayoutCellById") {
          try {
            return await checkCell(String(args[0]));
          } catch (error) {
            if ((error as { statusCode?: number }).statusCode === 404)
              return null;
            throw error;
          }
        }
        if (name === "listLayoutCells") {
          await requireResource("layouts", args[0]);
          const rows = await raw.listLayoutCells(String(args[0]));
          const visible = [];
          for (const cell of rows) {
            try {
              if (!admin) await references(cell, ["layouts", cell.layout_id]);
              visible.push(cell);
            } catch (error) {
              if (
                (error as { statusCode?: number }).statusCode !== 404 &&
                (error as { statusCode?: number }).statusCode !== 409
              )
                throw error;
            }
          }
          return visible;
        }
        if (name === "createLayoutCell") {
          const body = args[0] as { layout_id: string };
          await requireResource("layouts", body.layout_id);
          await references(body, ["layouts", body.layout_id]);
          return call(name, args);
        }
        if (name === "updateLayoutCell" || name === "deleteLayoutCell") {
          const cell = await checkCell(String(args[0]));
          await references(args[1], ["layouts", cell.layout_id]);
          return call(name, args);
        }
        if (name === "cloneLayout") {
          const id = String(args[0]);
          await requireResource("layouts", id);
          for (const cell of await raw.listLayoutCells(id))
            await references(cell, ["layouts", id]);
          for (const label of await raw.adapter.all<{ label_id: string }>(
            "SELECT label_id FROM layout_labels WHERE layout_id = ?",
            [id],
          ))
            await sameOwner("layouts", id, "labels", label.label_id);
          const result = await raw.cloneLayout(id),
            owner = await ownerOf("layouts", id);
          await claim("layouts", result.id, owner ?? actor);
          return result;
        }
        if (name === "queryEvents" || name === "queryKioskLogs")
          return call(name, [args[0], scope]);
        if (name === "listAudit")
          return raw.listAudit({ ...(args[0] as object), owner: scope });
        if (name === "getKioskLog") {
          const row = await raw.getKioskLog(String(args[0]));
          return row && (await access("kiosks", row.kiosk_id)) ? row : null;
        }
        if (
          name === "getDisplayDefaults" ||
          name === "getSetupExtra" ||
          name === "setSetupExtra"
        ) {
          if (enabled) requireBpAdmin(ctx);
          if (typeof args[0] === "string" && /node.?red/i.test(args[0]))
            requireBpAdmin(ctx);
          return call(name, args);
        }
        if (name === "getPairingCode") {
          const code = await call(name, args);
          if (code?.consumed_by_kiosk_id)
            await requireResource("kiosks", code.consumed_by_kiosk_id);
          return code;
        }
        if (name === "kioskNameExists") return call(name, args);
        if (name === "markPairingCodeClaimed") {
          await requireResource("kiosks", args[1]);
          return call(name, args);
        }
        if (name === "createDisplayForKiosk") {
          await requireResource("kiosks", args[0]);
          const result = await raw.createDisplayForKiosk(String(args[0]), {
            ...(args[1] as { name: string }),
            skipTenantDefaults: enabled,
          });
          const owner = await ownerOf("kiosks", String(args[0]));
          if (owner) await claim("displays", result.id, owner);
          return result;
        }
        if (
          name === "upsertCloudCamera" ||
          name === "deleteCloudCamerasNotIn"
        ) {
          const account =
            name === "upsertCloudCamera"
              ? (args[0] as { cloud_account_id: string }).cloud_account_id
              : String(args[0]);
          await requireResource("cloud_accounts", account);
          return call(name, args);
        }
        throw new Error(
          `BP repository method has no resource access policy: ${name}`,
        );
      };
    },
  }) as Repository;
  const nodered = admin
    ? deps.nodered
    : (new Proxy(deps.nodered ?? {}, {
        get(target, key) {
          // Internal domain notifications continue; editor, discovery and configuration stay admin-only.
          if (key === "forward")
            return (target as AdminDeps["nodered"]).forward?.bind(target);
          requireBpAdmin(ctx);
        },
      }) as AdminDeps["nodered"]);
  return raw.adapter.withSearchPath(tenant.schema_name, () =>
    raw.adapter.transaction(() =>
      operation({ ...deps, repo, nodered, bpTenant: tenant }),
    ),
  );
}

/** Explicit, one-time adoption of a known existing tenant; never infer an owner from email/name. */
export async function assignExistingBpResources(
  repo: Repository,
  schema: string,
  migrationId: string,
  owner: ResourceOwner,
): Promise<Record<string, number>> {
  if (
    !owner.subject.trim() ||
    !owner.issuer.startsWith("https://") ||
    !migrationId.trim()
  )
    throw new Error(
      "Explicit BP issuer, subject and migration identifier required",
    );
  return repo.adapter.withSearchPath(schema, () =>
    repo.adapter.transaction(async () => {
      await repo.adapter.get("SELECT pg_advisory_xact_lock(734192081)");
      const prior = await repo.adapter.get<ResourceOwner>(
        "SELECT owner_issuer AS issuer,owner_subject AS subject FROM bp_owner_bootstraps WHERE migration_id = ?",
        [migrationId],
      );
      if (prior) {
        if (prior.issuer !== owner.issuer || prior.subject !== owner.subject)
          throw new Error(
            "Ownership adoption already applied to another principal",
          );
        return {};
      }
      if (
        await repo.adapter.get(
          "SELECT 1 FROM bp_resource_owners WHERE owner_issuer <> ? OR owner_subject <> ? LIMIT 1",
          [owner.issuer, owner.subject],
        )
      )
        throw new Error(
          "Existing ownership requires an explicit transfer, not bootstrap adoption",
        );
      const counts: Record<string, number> = {};
      for (const table of OWNED_RESOURCE_TABLES) {
        const result = await repo.adapter.run(
          `INSERT INTO bp_resource_owners(resource_type,resource_id,owner_issuer,owner_subject) SELECT ?,id::text,?,? FROM ${table} ON CONFLICT DO NOTHING`,
          [table, owner.issuer, owner.subject],
        );
        counts[table] = result.changes;
      }
      await repo.adapter.run(
        "INSERT INTO bp_owner_bootstraps(migration_id,owner_issuer,owner_subject) VALUES(?,?,?)",
        [migrationId, owner.issuer, owner.subject],
      );
      return counts;
    }),
  );
}
