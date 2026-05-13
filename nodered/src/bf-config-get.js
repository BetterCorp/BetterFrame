/**
 * bf-config-get — fetch BetterFrame state via admin API.
 *
 * config.type selects the resource. Some types accept an optional id (passed
 * via config.id or msg.id). Responses are JSON; secrets (password_hash,
 * key_hash, onvif_password, totp_secret_encrypted, etc.) are stripped on the
 * server side.
 *
 * Supported types:
 *   displays         → /api/admin/displays            → msg.payload = [Display]
 *   kiosks           → /api/admin/kiosks              → msg.payload = [Kiosk]
 *   cameras          → /api/admin/cameras             → msg.payload = [Camera]
 *   layouts          → /api/admin/layouts             → msg.payload = [Layout]
 *   entities         → /api/admin/entities            → msg.payload = [Entity]
 *   display-by-id    → /api/admin/displays/:id        → msg.payload = Display
 *   kiosk-by-id      → /api/admin/kiosks/:id          → msg.payload = Kiosk
 *   camera-by-id     → /api/admin/cameras/:id         → msg.payload = Camera
 *   layout-by-id     → /api/admin/layouts/:id         → msg.payload = Layout
 *   entity-by-id     → /api/admin/entities/:id        → msg.payload = Entity
 */
module.exports = function (RED) {
  // Map type → {path(id) → string, listKey: string | null }
  // listKey: when set, response shape is {<listKey>: [...]}, we unwrap it.
  // For -by-id types, response shape is {<singularKey>: {...}} which is
  // unwrapped from the first key in the response object.
  const ROUTES = {
    "displays": { build: () => "/api/admin/displays", listKey: "displays" },
    "kiosks": { build: () => "/api/admin/kiosks", listKey: "kiosks" },
    "cameras": { build: () => "/api/admin/cameras", listKey: "cameras" },
    "layouts": { build: () => "/api/admin/layouts", listKey: "layouts" },
    "entities": { build: () => "/api/admin/entities", listKey: "entities" },
    "display-by-id": { build: (id) => "/api/admin/displays/" + encodeURIComponent(id), listKey: "display" },
    "kiosk-by-id": { build: (id) => "/api/admin/kiosks/" + encodeURIComponent(id), listKey: "kiosk" },
    "camera-by-id": { build: (id) => "/api/admin/cameras/" + encodeURIComponent(id), listKey: "camera" },
    "layout-by-id": { build: (id) => "/api/admin/layouts/" + encodeURIComponent(id), listKey: "layout" },
    "entity-by-id": { build: (id) => "/api/admin/entities/" + encodeURIComponent(id), listKey: "entity" },
  };

  function BfConfigGetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);

    node.on("input", async (msg, send, done) => {
      if (!cfg || !cfg.server_url || !cfg.api_key) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return done(new Error("bf-server-config server_url + api_key required"));
      }
      const type = (msg.type || config.type || "").trim();
      const route = ROUTES[type];
      if (!route) {
        node.status({ fill: "red", shape: "ring", text: "bad type" });
        return done(new Error("unknown type: " + type));
      }
      const id = msg.id !== undefined && msg.id !== "" ? msg.id : config.id;
      const needsId = type.endsWith("-by-id");
      if (needsId && (id === undefined || id === null || id === "")) {
        node.status({ fill: "red", shape: "ring", text: "missing id" });
        return done(new Error("id required for type " + type));
      }
      const url = cfg.server_url + route.build(id);
      try {
        const r = await fetch(url, {
          method: "GET",
          headers: {
            authorization: "Bearer " + cfg.api_key,
            accept: "application/json",
          },
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        // Unwrap the predictable envelope shape.
        let payload;
        if (route.listKey && data && Object.prototype.hasOwnProperty.call(data, route.listKey)) {
          payload = data[route.listKey];
        } else {
          payload = data;
        }
        msg.payload = payload;
        const n = Array.isArray(payload) ? payload.length : 1;
        node.status({ fill: "green", shape: "dot", text: type + " (" + String(n) + ")" });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }
  RED.nodes.registerType("bf-config-get", BfConfigGetNode);
};
