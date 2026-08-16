import { createHash, timingSafeEqual } from "node:crypto";
import { getCookie, type H3Event } from "h3";

import type { Session } from "./types.js";

export function requestOriginIsValid(event: H3Event): boolean {
  const site = event.req.headers.get("sec-fetch-site");
  if (site === "cross-site") return false;

  const origin = event.req.headers.get("origin");
  const host = event.req.headers.get("x-forwarded-host") ?? event.req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function csrfRequestIsValid(event: H3Event, session: Session): boolean {
  if (!requestOriginIsValid(event)) return false;
  const supplied = getCookie(event, "betterframe_csrf") ?? "";
  if (!supplied) return false;
  const actual = createHash("sha256").update(supplied).digest();
  const expected = createHash("sha256").update(session.csrf_token).digest();
  return timingSafeEqual(actual, expected);
}
