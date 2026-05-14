/**
 * Audit logging helper — single inline call from route handlers.
 *
 *   audit(repo, event, "user.login", { result: "ok" });
 *   audit(repo, event, "firmware.upload", { resource_id: rel.id, metadata: { version, channel } });
 *
 * Pulls actor + ip out of the h3 event context. Never throws — logging
 * failure must not break the caller's request.
 */
import type { Repository } from "../plugins/service-store/repository.js";
import type { AuditActorType, AuditResult } from "./types.js";

interface AuditCtx {
  context?: {
    user?: { id?: number; username?: string };
    apiKeyPrefix?: string;
    session?: unknown;
  };
  req?: { headers: { get(name: string): string | null } };
}

export interface AuditInput {
  resource_type?: string;
  resource_id?: string | number;
  metadata?: Record<string, unknown>;
  result?: AuditResult;
  /** Override actor (e.g. when system performs action on behalf of nobody). */
  actor_type?: AuditActorType;
  actor_id?: number | null;
  actor_label?: string | null;
}

export function audit(
  repo: Repository,
  event: AuditCtx | null,
  action: string,
  input: AuditInput = {},
): void {
  try {
    const ctx = event?.context;
    let actor_type: AuditActorType = input.actor_type ?? "system";
    let actor_id: number | null = input.actor_id ?? null;
    let actor_label: string | null = input.actor_label ?? null;

    if (!input.actor_type && ctx) {
      if (ctx.apiKeyPrefix) {
        actor_type = "api_key";
        actor_label = ctx.apiKeyPrefix;
      } else if (ctx.user) {
        actor_type = "user";
        actor_id = ctx.user.id ?? null;
        actor_label = ctx.user.username ?? null;
      }
    }

    const headers = event?.req?.headers;
    const ip = headers?.get("x-real-ip")
      ?? headers?.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? null;

    repo.insertAudit({
      actor_type,
      actor_id,
      actor_label,
      action,
      resource_type: input.resource_type ?? null,
      resource_id: input.resource_id != null ? String(input.resource_id) : null,
      ip,
      metadata: input.metadata ?? {},
      result: input.result ?? "ok",
    });
  } catch {
    /* never throw from audit */
  }
}
