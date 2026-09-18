import { createError } from "h3";
import { KioskLogsBody, validateBody } from "./api-schemas.js";

/** Validate the whole batch before writing any rows, so one bad event cannot
 * create a partially accepted batch that retries forever. */
export function parseKioskLogs(raw: unknown) {
  const body = validateBody(KioskLogsBody, raw);
  if (body.entries.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "entries must contain 1–100 logs" });
  }
  const validLevels = new Set(["debug", "info", "warn", "error"]);
  return body.entries.map((entry) => {
    if (!entry.message.length) {
      throw createError({ statusCode: 400, statusMessage: "log message is required" });
    }
    if (entry.logged_at && !Number.isFinite(Date.parse(entry.logged_at))) {
      throw createError({ statusCode: 400, statusMessage: "invalid log timestamp" });
    }
    if (entry.context == null || typeof entry.context !== "object" || Array.isArray(entry.context)
        || JSON.stringify(entry.context).length > 8192) {
      throw createError({ statusCode: 400, statusMessage: "log context must be an object up to 8192 characters" });
    }
    return {
      level: (validLevels.has(entry.level) ? entry.level : "info") as "debug" | "info" | "warn" | "error",
      message: entry.message,
      context: entry.context as Record<string, unknown>,
      logged_at: entry.logged_at ? new Date(entry.logged_at).toISOString() : undefined,
      event_id: entry.event_id,
    };
  });
}
