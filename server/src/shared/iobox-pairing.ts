import { randomBytes } from "node:crypto";
import type { Repository } from "./db/repository.js";
import type { AuthApi } from "./auth.js";
import type { SecretsApi } from "./secrets.js";
import { matchesSecret, secretHash } from "./pairing.js";

interface ClaimRow { provisioning_secret_hash: string; claim_encrypted: string | null; acknowledged_at: unknown }
interface Tenant { id: string | null; slug: string; schema_name: string }

// Serial row locks serialize announce, claim and acknowledgement across API replicas.
export async function bindIoBoxProvisioning(repo: Repository, serial: string, secret?: string): Promise<void> {
  if (!secret) return;
  await repo.transact(async () => {
    const serialRow = await repo.adapter.get<{ paired_iobox_id: string | null }>(
      "SELECT paired_iobox_id FROM public.iobox_serials WHERE serial = ? FOR UPDATE", [serial],
    );
    if (!serialRow) throw new Error("unknown serial");
    const claim = await repo.adapter.get<ClaimRow>("SELECT * FROM public.iobox_pairing_claims WHERE serial = ?", [serial]);
    if (claim) {
      if (!matchesSecret(secret, claim.provisioning_secret_hash)) throw new Error("invalid provisioning secret");
    } else {
      // Never retroactively grant access to credentials issued through legacy enrollment.
      if (serialRow.paired_iobox_id) throw new Error("serial already paired; operator reset required");
      await repo.adapter.run("INSERT INTO public.iobox_pairing_claims (serial, provisioning_secret_hash) VALUES (?, ?)", [serial, secretHash(secret)]);
    }
  });
}

export async function claimIoBox(
  repo: Repository, auth: AuthApi, secrets: SecretsApi,
  input: { serial: string; provisioning_secret?: string; name?: string; assigned_display_id?: string | null }, tenant: Tenant,
): Promise<Record<string, unknown>> {
  return repo.transact(async () => {
    await repo.adapter.get("SELECT serial FROM public.iobox_serials WHERE serial = ? FOR UPDATE", [input.serial]);
    const registered = await repo.getIoBoxSerial(input.serial);
    if (!registered) throw new Error("unknown serial");
    await bindIoBoxProvisioning(repo, input.serial, input.provisioning_secret);
    const claim = await repo.adapter.get<ClaimRow>("SELECT * FROM public.iobox_pairing_claims WHERE serial = ?", [input.serial]);
    if (claim && !matchesSecret(input.provisioning_secret, claim.provisioning_secret_hash)) throw new Error("invalid provisioning secret");
    if (registered.paired_iobox_id) {
      if (!claim?.claim_encrypted) throw new Error("serial already paired");
      const envelope = JSON.parse(secrets.decryptString(claim.claim_encrypted, "iobox-pairing-claim"));
      const assignedTenant = registered.paired_tenant_id ? await repo.getTenantById(registered.paired_tenant_id) : null;
      if (registered.paired_tenant_id && !assignedTenant?.is_active) throw new Error("tenant unavailable");
      const box = await repo.adapter.withSearchPath(assignedTenant?.schema_name ?? "public", () => repo.getIoBoxById(registered.paired_iobox_id!));
      if (!box?.enabled) throw new Error("device revoked");
      return envelope;
    }
    const model = await repo.getIoBoxModel(registered.model_id);
    if (!model) throw new Error("serial model missing");
    return repo.adapter.withSearchPath(tenant.schema_name, async () => {
      const plaintext = `bfio-${randomBytes(24).toString("base64url")}`;
      const box = await repo.createIoBox({
        serial: input.serial, model_id: model.id,
        name: input.name?.trim() || `${model.name} ${input.serial}`,
        key_hash: await auth.hashPassword(plaintext), key_prefix: plaintext.slice(0, 8),
        assigned_display_id: input.assigned_display_id ?? null,
      });
      await repo.markIoBoxSerialPaired(input.serial, tenant.id, box.id);
      const envelope = {
        status: "claimed", tenant_slug: tenant.slug, iobox_id: box.id, iobox_key: plaintext,
        config_url: "/api/iobox/config", heartbeat_url: "/api/iobox/heartbeat",
      };
      if (claim) await repo.adapter.run("UPDATE public.iobox_pairing_claims SET claim_encrypted = ? WHERE serial = ?", [
        secrets.encryptString(JSON.stringify(envelope), "iobox-pairing-claim"), input.serial,
      ]);
      return envelope;
    });
  });
}

export async function acknowledgeIoBox(repo: Repository, serial: string, deviceId: string, tenantId: string, secret?: string): Promise<void> {
  await repo.transact(async () => {
    await repo.adapter.get("SELECT serial FROM public.iobox_serials WHERE serial = ? FOR UPDATE", [serial]);
    const registered = await repo.getIoBoxSerial(serial);
    const claim = await repo.adapter.get<ClaimRow>("SELECT * FROM public.iobox_pairing_claims WHERE serial = ?", [serial]);
    if (registered?.paired_iobox_id !== deviceId || registered?.paired_tenant_id !== tenantId || !claim || !matchesSecret(secret, claim.provisioning_secret_hash)) {
      throw new Error("invalid pairing acknowledgement");
    }
    await repo.adapter.run("UPDATE public.iobox_pairing_claims SET claim_encrypted = NULL, acknowledged_at = COALESCE(acknowledged_at, now()) WHERE serial = ?", [serial]);
  });
}
