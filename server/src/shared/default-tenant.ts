import type { Repository } from "./db/repository.js";

export function currentTenantSchema(event: { context?: { tenant?: { schema_name?: string } } }): string | null {
  return event.context?.tenant?.schema_name ?? null;
}

export function isDefaultTenant(event: { context?: { tenant?: { slug?: string } } }): boolean {
  const slug = event.context?.tenant?.slug ?? "default";
  return slug === "default";
}

export async function withDefaultTenant<T>(
  repo: Repository,
  restoreSchema: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (repo.adapter.dialect() !== "postgres") return fn();
  await repo.adapter.setSearchPath("public");
  try {
    return await fn();
  } finally {
    await repo.adapter.setSearchPath(restoreSchema ?? "public");
  }
}
