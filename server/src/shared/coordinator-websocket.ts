import { WebSocketServer } from "ws";

// Camera proxy responses support 10 MiB of binary data. Base64 expands that
// to about 13.34 MiB; allow JSON metadata too while keeping a finite limit.
export const COORDINATOR_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export function createCoordinatorWebSocketServer(): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    maxPayload: COORDINATOR_MAX_PAYLOAD_BYTES,
  });
}
