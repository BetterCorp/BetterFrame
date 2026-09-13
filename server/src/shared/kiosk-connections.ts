export interface KioskSocket {
  terminate(): void;
}

export interface KioskConnection<S extends KioskSocket> {
  id: string;
  name: string;
  ws: S;
  lastPong: number;
}

/** Connection ownership survives delayed close events from a replaced socket. */
export class KioskConnections<S extends KioskSocket> extends Map<string, KioskConnection<S>> {
  removeSocket(id: string, socket: S): boolean {
    if (this.get(id)?.ws !== socket) return false;
    return this.delete(id);
  }

  pong(id: string, socket: S, now = Date.now()): void {
    const connection = this.get(id);
    if (connection?.ws === socket) connection.lastPong = now;
  }

  terminateStale(now = Date.now(), timeoutMs = 90_000): void {
    for (const connection of this.values()) {
      if (now - connection.lastPong > timeoutMs) connection.ws.terminate();
    }
  }
}
