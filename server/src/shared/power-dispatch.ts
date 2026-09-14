import type { KioskConnection, KioskSocket } from "./kiosk-connections.js";

interface PowerSocket extends KioskSocket {
  readyState: number;
  send(payload: string, callback: (error?: Error) => void): void;
}

/** Confirms validation and transport completion; this is not a device execution ACK. */
export function dispatchPower<S extends PowerSocket>(
  connections: ReadonlyMap<string, KioskConnection<S>>,
  kioskId: string,
  message: object,
  timeoutMs = 5_000,
): Promise<boolean> {
  const connection = connections.get(kioskId);
  const type = (message as Record<string, unknown>)["type"];
  if (!connection || connection.ws.readyState !== 1 || (type !== "standby" && type !== "wake")) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (sent: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
        connection.ws.send(JSON.stringify(message), (error) => finish(!error && stillCurrent()));
      } catch {
        finish(false);
      }
    })();
  });
}
