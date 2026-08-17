import type { DbAdapter } from "./db-adapter.js";

export function quotedSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`invalid schema name: ${schema}`);
  return `"${schema}"`;
}

/** Copy authoritative platform-admin authentication state into tenant schemas. */
export async function mirrorPlatformAdmins(
  adapter: DbAdapter,
  schemas: readonly string[],
  adminId?: string,
): Promise<void> {
  const idFilter = adminId ? " AND source.id = ?" : "";
  const params = adminId ? [adminId] : [];

  for (const schema of schemas) {
    const target = quotedSchema(schema);
    await adapter.run(
      `UPDATE ${target}.users AS target
          SET password_hash = source.password_hash,
              role = source.role,
              is_active = source.is_active,
              totp_enabled = source.totp_enabled,
              totp_secret_encrypted = source.totp_secret_encrypted,
              recovery_codes_hashed = source.recovery_codes_hashed,
              must_change_password = source.must_change_password,
              failed_login_count = source.failed_login_count,
              locked_until = source.locked_until,
              last_login_at = source.last_login_at
         FROM public.users AS source
        WHERE source.role = 'admin'
          AND target.username = source.username${idFilter}`,
      params,
    );
    await adapter.run(
      `INSERT INTO ${target}.users
         (id, username, password_hash, role, is_active, totp_enabled,
          totp_secret_encrypted, recovery_codes_hashed, must_change_password,
          failed_login_count, locked_until, last_login_at, created_at)
       SELECT source.id, source.username, source.password_hash, source.role,
              source.is_active, source.totp_enabled, source.totp_secret_encrypted,
              source.recovery_codes_hashed, source.must_change_password,
              source.failed_login_count, source.locked_until, source.last_login_at,
              source.created_at
         FROM public.users AS source
        WHERE source.role = 'admin'${idFilter}
          AND NOT EXISTS (
            SELECT 1 FROM ${target}.users existing
             WHERE existing.id = source.id OR existing.username = source.username
          )
       ON CONFLICT DO NOTHING`,
      params,
    );
  }
}
