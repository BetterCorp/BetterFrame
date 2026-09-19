import type { Repository } from "./db/repository.js";

/** Include inactive tenants: disabling an account must not disable retention. */
export async function purgeTenantKioskLogs(
  repo: Repository, hours: number, warn: (message: string) => void,
): Promise<number> {
  let removed = 0;
  for (const tenant of await repo.listTenants()) {
    try {
      removed += await repo.adapter.withSearchPath(tenant.schema_name, () => repo.purgeOldKioskLogs(hours));
    } catch {
      warn(`kiosk log cleanup failed for tenant ${tenant.id}`);
    }
  }
  return removed;
}
