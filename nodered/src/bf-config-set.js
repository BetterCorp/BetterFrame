/**
 * bf-config-set — mutate BetterFrame state via admin API.
 *
 * config.type selects the mutation. config.id (or msg.id) identifies the
 * target entity. The new value comes from msg.payload (or config.value).
 * Wire format is uniform: `POST /api/admin/<resource>/:id/<field>` with
 * body `{ value: <new value> }`.
 *
 * Response body is the updated entity (passwords stripped), placed on
 * msg.payload.
 *
 * Supported types:
 *   display.default-layout → POST /api/admin/displays/:id/default-layout {value: layout_id|null}
 *   kiosk.enabled          → POST /api/admin/kiosks/:id/enabled         {value: boolean}
 *   camera.enabled         → POST /api/admin/cameras/:id/enabled        {value: boolean}
 *   layout.priority        → POST /api/admin/layouts/:id/priority       {value: "hot"|"normal"|"cold"}
 *   entity.name            → POST /api/admin/entities/:id/name          {value: string}
 */
module.exports = function (RED) {
  const ROUTES = {
    "display.default-layout": (id) => "/api/admin/displays/" + encodeURIComponent(id) + "/default-layout",
    "kiosk.enabled": (id) => "/api/admin/kiosks/" + encodeURIComponent(id) + "/enabled",
    "camera.enabled": (id) => "/api/admin/cameras/" + encodeURIComponent(id) + "/enabled",
    "layout.priority": (id) => "/api/admin/layouts/" + encodeURIComponent(id) + "/priority",
    "entity.name": (id) => "/api/admin/entities/" + encodeURIComponent(id) + "/name",
  };

  function coerceValue(type, raw) {
    if (type === "kiosk.enabled" || type === "camera.enabled") {
      if (typeof raw === "string") {
        const t = raw.trim().toLowerCase();
        if (t === "true" || t === "1" || t === "yes" || t === "on") return true;
        if (t === "false" || t === "0" || t === "no" || t === "off" || t === "") return false;
      }
      return Boolean(raw);
    }
    if (type === "display.default-layout") {
      if (raw === null || raw === undefined || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    return raw;
  }

  function BfConfigSetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);

    node.on("input", async (msg, send, done) => {
      if (!cfg || !cfg.server_url || !cfg.api_key) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return done(new Error("bf-server-config server_url + api_key required"));
      }
      const type = (msg.type || config.type || "").trim();
      const build = ROUTES[type];
      if (!build) {
        node.status({ fill: "red", shape: "ring", text: "bad type" });
        return done(new Error("unknown type: " + type));
      }
      const id = msg.id !== undefined && msg.id !== "" ? msg.id : config.id;
      if (id === undefined || id === null || id === "") {
        node.status({ fill: "red", shape: "ring", text: "missing id" });
        return done(new Error("id required"));
      }
      // Pick the new value. msg.payload wins, then msg.value, then config.value.
      const rawValue = msg.payload !== undefined
        ? msg.payload
        : (msg.value !== undefined ? msg.value : config.value);
      const value = coerceValue(type, rawValue);

      const url = cfg.server_url + build(id);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            authorization: "Bearer " + cfg.api_key,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ value: value }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        // Unwrap the predictable envelope shape — first key holds the entity.
        let payload = data;
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const keys = Object.keys(data);
          if (keys.length === 1) payload = data[keys[0]];
        }
        msg.payload = payload;
        node.status({ fill: "green", shape: "dot", text: type });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }
  RED.nodes.registerType("bf-config-set", BfConfigSetNode);
};
