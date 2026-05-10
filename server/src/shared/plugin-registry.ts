/**
 * Module-level store registry — the one cross-plugin reference needed.
 *
 * service-store registers its repo in init(). Downstream plugins
 * (admin-http, api-http, coordinator-ws) look it up in their init().
 * initAfterPlugins guarantees ordering.
 */
import type { Repository } from "../plugins/service-store/repository.js";

let _repo: Repository | undefined;

export function registerRepo(repo: Repository): void {
  _repo = repo;
}

export function getRepo(): Repository {
  if (!_repo) throw new Error("plugin-registry: store repo not registered (init order bug?)");
  return _repo;
}
