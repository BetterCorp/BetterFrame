/**
 * Coordinator registry — admin-http calls these to notify kiosks of changes.
 * service-coordinator-ws sets the implementation in its init().
 */
export interface CoordinatorApi {
  sendToKiosk(kioskId: number, message: object): boolean;
  broadcastAll(message: object): void;
  notifyBundleChanged(): void;
  notifyKioskBundleChanged(kioskId: number): void;
}

const noop: CoordinatorApi = {
  sendToKiosk: () => false,
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
