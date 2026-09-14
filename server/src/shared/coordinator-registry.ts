/**
 * Coordinator registry — admin-http calls these to notify kiosks of changes.
 * service-coordinator-ws sets the implementation in its init().
 */
export interface CoordinatorApi {
  sendToKiosk(kioskId: string, message: object, queueWhenOffline?: boolean): boolean;
  /** Android true confirms validation, write and accepted logical-state ACK; desktop true confirms write. */
  sendPowerToKiosk(kioskId: string, message: object): Promise<boolean>;
  requestKiosk<T = unknown>(kioskId: string, message: object, timeoutMs?: number): Promise<T>;
  broadcastAll(message: object): void;
  notifyBundleChanged(): void;
  notifyKioskBundleChanged(kioskId: string): void;
}

const noop: CoordinatorApi = {
  sendToKiosk: () => false,
  sendPowerToKiosk: async () => false,
  requestKiosk: async () => { throw new Error("kiosk is not connected"); },
  broadcastAll: () => {},
  notifyBundleChanged: () => {},
  notifyKioskBundleChanged: () => {},
};

let _coordinator: CoordinatorApi = noop;

export function setCoordinator(c: CoordinatorApi): void {
  _coordinator = c;
}

export function getCoordinator(): CoordinatorApi {
  return _coordinator;
}
