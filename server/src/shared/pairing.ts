/**
 * Pairing state machine — shared module.
 *
 * Flow:
 *   1. Kiosk calls initiate → gets 8-char code + expiry
 *   2. Kiosk polls claim → 202 until admin confirms, then 200 + credentials
 *   3. Admin enters code in UI → confirmPairing creates kiosk + kiosk_key
 */
import { randomBytes } from "node:crypto";
import type { Repository } from "../plugins/service-store/repository.js";
import type { AuthApi } from "./auth.js";
import type { SecretsApi } from "./secrets.js";
import type { PairingCode } from "./types.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_LENGTH = 8;

function generateCode(): string {
  const buf = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length];
  }
  return code;
}

export interface PairingInitiateInput {
  proposedName: string | null;
  hardwareModel: string | null;
  capabilities: string[];
  /** True iff kiosk runs our pre-built Pi image with the apply-config helper. */
  managedImage?: boolean;
  codeTtlSeconds: number;
}

export interface PairingInitiateResult {
  code: string;
  expiresAt: string;
}

export function initiatePairing(
  repo: Repository,
  input: PairingInitiateInput,
): PairingInitiateResult {
  let code: string;
  let attempts = 0;
  do {
    code = generateCode();
    attempts++;
    if (attempts > 20) throw new Error("failed to generate unique pairing code");
  } while (repo.getPairingCode(code) !== null);

  const expiresAt = new Date(Date.now() + input.codeTtlSeconds * 1000).toISOString();

  repo.createPairingCode({
    code,
    kiosk_proposed_name: input.proposedName,
    kiosk_hardware_model: input.hardwareModel,
    kiosk_capabilities: input.capabilities,
    expires_at: expiresAt,
    extras: input.managedImage ? { managed_image: true } : {},
  });

  return { code, expiresAt };
}

export interface PairingClaimResult {
  status: "pending" | "claimed";
  kioskId?: number;
  kioskName?: string;
  kioskKey?: string;
  clusterKey?: string;
  bundleUrl?: string;
}

export function claimPairing(
  repo: Repository,
  code: string,
): PairingClaimResult {
  const pc = repo.getPairingCode(code);
  if (!pc) return { status: "pending" };
  if (new Date(pc.expires_at) < new Date()) return { status: "pending" };
  if (!pc.consumed_at) return { status: "pending" };

  const extras = pc.extras as Record<string, unknown>;
  const kioskKey = extras["kiosk_key_plaintext"] as string | undefined;

  if (!kioskKey || !pc.consumed_by_kiosk_id) return { status: "pending" };

  const kiosk = repo.getKioskById(pc.consumed_by_kiosk_id);
  const clusterKey = extras["cluster_key"] as string | undefined;

  // Wipe plaintext key from extras after first claim
  repo.updatePairingCodeExtras(code, { ...extras, kiosk_key_plaintext: undefined, cluster_key: undefined });

  return {
    status: "claimed",
    kioskId: pc.consumed_by_kiosk_id,
    kioskName: kiosk?.name ?? pc.kiosk_proposed_name ?? "kiosk",
    kioskKey,
    clusterKey,
    bundleUrl: "/api/kiosk/bundle",
  };
}

export interface PairingConfirmInput {
  code: string;
  nameOverride?: string;
  initialLabels?: string[];
  /**
   * If set, rekey this existing kiosk instead of creating a new one. Display
   * assignments, labels, GPIO bindings, and layout references all stay
   * pointed at the same kiosk id — only credentials + hardware metadata roll.
   * When set, nameOverride and initialLabels are ignored.
   */
  replaceKioskId?: number;
  /** Bypass replacement-target sanity checks (hardware_model / capabilities / managed_image). */
  force?: boolean;
}

export async function confirmPairing(
  repo: Repository,
  auth: AuthApi,
  secrets: SecretsApi,
  input: PairingConfirmInput,
): Promise<{ kioskId: number; kioskName: string }> {
  const pc = repo.getPairingCode(input.code);
  if (!pc) throw new Error("pairing code not found");
  if (pc.consumed_at) throw new Error("pairing code already used");
  if (new Date(pc.expires_at) < new Date()) throw new Error("pairing code expired");

  const kioskKeyPlaintext = `bf-${randomBytes(24).toString("base64url")}`;
  const kioskKeyHash = await auth.hashPassword(kioskKeyPlaintext);
  const kioskKeyPrefix = kioskKeyPlaintext.slice(0, 8);

  let kioskId: number;
  let kioskName: string;

  if (input.replaceKioskId != null) {
    const existing = repo.getKioskById(input.replaceKioskId);
    if (!existing) throw new Error("replacement target kiosk not found");

    // Sanity-check the incoming device matches the slot it's replacing.
    // Identity-bearing fields (hardware_model, managed_image) shouldn't drift
    // on a like-for-like swap. Capabilities CAN narrow legitimately, so warn
    // but don't block. force=1 from the form bypasses the whole check.
    if (!input.force) {
      const mismatches: string[] = [];
      const newHw = pc.kiosk_hardware_model ?? null;
      if (existing.hardware_model && newHw && existing.hardware_model !== newHw) {
        mismatches.push(`hardware_model: ${existing.hardware_model} → ${newHw}`);
      }
      const newManaged = pc.extras?.["managed_image"] === true;
      if (existing.managed_image !== newManaged) {
        mismatches.push(`managed_image: ${existing.managed_image} → ${newManaged}`);
      }
      const lostCaps = existing.capabilities.filter((c) => !pc.kiosk_capabilities.includes(c));
      if (lostCaps.length > 0) {
        mismatches.push(`lost capabilities: ${lostCaps.join(", ")}`);
      }
      if (mismatches.length > 0) {
        throw new Error(
          `replacement device differs from existing kiosk — ${mismatches.join("; ")}. `
          + `Re-submit with "force replace" to override.`,
        );
      }
    }

    repo.replaceKioskKey(existing.id, {
      key_hash: kioskKeyHash,
      key_prefix: kioskKeyPrefix,
      capabilities: pc.kiosk_capabilities,
      hardware_model: pc.kiosk_hardware_model,
    });
    // managed_image flag follows the new device (handled on row above via
    // capabilities/hw, but the explicit column is updated separately because
    // replaceKioskKey doesn't touch it).
    if (existing.managed_image !== (pc.extras?.["managed_image"] === true)) {
      repo.updateKiosk(existing.id, { managed_image: pc.extras?.["managed_image"] === true } as any);
    }
    kioskId = existing.id;
    kioskName = existing.name;
  } else {
    const baseName = input.nameOverride || pc.kiosk_proposed_name || `kiosk-${input.code.toLowerCase()}`;
    let candidate = baseName;
    let suffix = 2;
    while (repo.getKioskByName(candidate)) {
      candidate = `${baseName}-${suffix}`;
      suffix++;
      if (suffix > 100) throw new Error("could not generate unique kiosk name");
    }

    const kiosk = repo.createKiosk({
      name: candidate,
      key_hash: kioskKeyHash,
      key_prefix: kioskKeyPrefix,
      capabilities: pc.kiosk_capabilities,
      hardware_model: pc.kiosk_hardware_model,
      managed_image: pc.extras?.["managed_image"] === true,
    });

    repo.createDisplayForKiosk(kiosk.id, {
      name: `${candidate} HDMI-0`,
    });

    if (input.initialLabels?.length) {
      for (const labelName of input.initialLabels) {
        const trimmed = labelName.trim().toLowerCase();
        if (!trimmed) continue;
        const label = repo.ensureLabel(trimmed);
        repo.attachKioskLabel(kiosk.id, label.id, "consume");
      }
    }

    kioskId = kiosk.id;
    kioskName = candidate;
  }

  // Cluster key delivery (shared across pair + replace)
  const clusterKeyEncrypted = repo.getSetupExtra("cluster_key_encrypted") as string | undefined;
  const clusterKey = clusterKeyEncrypted ? secrets.decryptString(clusterKeyEncrypted, "cluster") : undefined;

  repo.markPairingCodeClaimed(input.code, kioskId, {
    kiosk_key_plaintext: kioskKeyPlaintext,
    cluster_key: clusterKey,
  });

  return { kioskId, kioskName };
}
