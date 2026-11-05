/** Owner identity is provider + subject, scoped by the existing tenant schema. */
export interface ResourceOwner {
  issuer: string;
  subject: string;
}
export const OWNED_RESOURCE_TABLES = [
  "cameras",
  "camera_devices",
  "kiosks",
  "displays",
  "layouts",
  "entities",
  "labels",
  "ioboxes",
  "cloud_accounts",
  "firmware_releases",
  "os_update_releases",
  "ablesign_accounts",
] as const;
export type OwnedResource = (typeof OWNED_RESOURCE_TABLES)[number];

/** Static identifiers only; caller values are always bound parameters. */
export function ownershipPredicate(
  table: OwnedResource,
  alias: string,
  owner?: ResourceOwner,
): { sql: string; params: string[] } {
  if (!owner) return { sql: "TRUE", params: [] };
  const own = (kind: string, id: string) => ({
    sql: `EXISTS (SELECT 1 FROM bp_resource_owners bp_owner WHERE bp_owner.resource_type = ${kind} AND bp_owner.resource_id = (${id})::text AND bp_owner.owner_issuer = ? AND bp_owner.owner_subject = ?)`,
    params: [owner.issuer, owner.subject],
  });
  if (table === "displays")
    return own(
      `CASE WHEN ${alias}.kiosk_id IS NULL THEN 'displays' ELSE 'kiosks' END`,
      `COALESCE(${alias}.kiosk_id, ${alias}.id)`,
    );
  if (table === "cameras")
    return own(
      `CASE WHEN ${alias}.cloud_account_id IS NOT NULL THEN 'cloud_accounts' WHEN ${alias}.device_id IS NOT NULL THEN 'camera_devices' ELSE 'cameras' END`,
      `COALESCE(${alias}.cloud_account_id, ${alias}.device_id, ${alias}.id)`,
    );
  if (table === "entities") {
    const camera = ownershipPredicate("cameras", "bp_camera", owner);
    const direct = own("'entities'", `${alias}.id`);
    return {
      sql: `((${alias}.type = 'camera' AND ${alias}.camera_id IS NOT NULL AND EXISTS (SELECT 1 FROM cameras bp_camera WHERE bp_camera.id = ${alias}.camera_id AND ${camera.sql})) OR ((${alias}.type <> 'camera' OR ${alias}.camera_id IS NULL) AND ${direct.sql}))`,
      params: [...camera.params, ...direct.params],
    };
  }
  return own(`'${table}'`, `${alias}.id`);
}
