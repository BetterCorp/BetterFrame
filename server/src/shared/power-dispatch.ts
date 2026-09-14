import { randomUUID } from "node:crypto";
import type { KioskConnection, KioskSocket } from "./kiosk-connections.js";

interface PowerSocket extends KioskSocket {
  readyState: number;
  send(payload: string, callback: (error?: Error) => void): void;
}

const activeViewerPower = new WeakSet<object>();

export interface PowerAcknowledgement {
  result: Promise<boolean>;
  cancel(): void;
}

/** Android confirms logical state via ACK; desktop confirms transport completion only. */
export function dispatchPower<S extends PowerSocket>(
  connections: ReadonlyMap<string, KioskConnection<S>>,
  kioskId: string,
  message: object,
  timeoutMs = 5_000,
  registerAck?: (connection: KioskConnection<S>, requestId: string) => PowerAcknowledgement,
): Promise<boolean> {
  const connection = connections.get(kioskId);
  const type = (message as Record<string, unknown>)["type"];
  if (!connection || connection.ws.readyState !== 1 || (type !== "standby" && type !== "wake")) {
    return Promise.resolve(false);
  }
  const viewer = Boolean(connection.validateViewerLayout);
  if (viewer && activeViewerPower.has(connection.ws)) return Promise.resolve(false);
  if (viewer) activeViewerPower.add(connection.ws);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let cancelAck = () => {};
    const finish = (sent: boolean) => {
      if (settled) return;
      settled = true;
      if (viewer) activeViewerPower.delete(connection.ws);
      clearTimeout(timer);
      cancelAck();
      resolve(sent);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const stillCurrent = () => !settled && connections.get(kioskId) === connection && connection.ws.readyState === 1;
    void (async () => {
      try {
        if (connection.validateViewerLayout) {
          if (!connection.validateViewerPower || !await connection.validateViewerPower(message)) return finish(false);
        }
        if (!stillCurrent()) return finish(false);
        let written = false;
        let accepted = false;
        let payload = message;
        if (viewer) {
          if (!registerAck) return finish(false);
          const requestId = randomUUID();
          const ack = registerAck(connection, requestId);
          cancelAck = () => ack.cancel();
          payload = { ...message, request_id: requestId };
          void ack.result.then((value) => {
            if (!value || !stillCurrent()) return finish(false);
            accepted = true;
            if (written) finish(true);
          }, () => finish(false));
        }
        connection.ws.send(JSON.stringify(payload), (error) => {
          if (error || !stillCurrent()) return finish(false);
          written = true;
          if (!viewer || accepted) finish(true);
        });
      } catch {
        finish(false);
      }
    })();
  });
}

interface PendingPowerResponse<S> {
  kioskId: string;
  socket: S;
  responseType?: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
}

/** Bind ACKs to their request and authenticated socket; malformed responses do not consume it. */
export function acceptPowerResult<S>(
  pendingRequests: Map<string, PendingPowerResponse<S>>,
  kioskId: string,
  socket: S,
  message: Record<string, unknown>,
): boolean {
  const requestId = typeof message["request_id"] === "string" ? message["request_id"] : "";
  const pending = pendingRequests.get(requestId);
  if (message["type"] !== "power-result" || !pending || pending.responseType !== "power-result"
    || pending.kioskId !== kioskId || pending.socket !== socket || typeof message["accepted"] !== "boolean") return false;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(message["accepted"]);
  return true;
}
