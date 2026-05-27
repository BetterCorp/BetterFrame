/**
 * bf-status — query the current state of a kiosk by ID.
 *
 * GETs /api/admin/kiosks/:id and returns the kiosk object as msg.payload.
 * The server applies stripSecrets() before returning JSON, so key_hash and
 * other credentials are already removed by the time we see them.
 *
 * Useful for: "what's the temperature right now?" / "is this kiosk online?"
 * style polls. For push-driven telemetry use bf-trigger-status instead.
 *
 * config.kiosk_id: numeric (overridable by msg.kiosk_id)
 */
const { adminHeaders } = require("./_tenant.js");

module.exports = function (RED) {
  function BfStatusNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);

    node.on("input", async (msg, send, done) => {
      if (!cfg || !cfg.server_url || !cfg.api_key) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return done(new Error("bf-server-config server_url + api_key required"));
      }
      const kioskId = msg.kiosk_id || config.kiosk_id;
      if (!kioskId) {
        node.status({ fill: "red", shape: "ring", text: "missing kiosk_id" });
        return done(new Error("kiosk_id required"));
      }
      const url = cfg.server_url + "/api/admin/kiosks/" + encodeURIComponent(String(kioskId));
      try {
        const r = await fetch(url, {
          method: "GET",
          headers: adminHeaders(cfg, { accept: "application/json" }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        // Server envelope is { kiosk: {...} } — unwrap to match bf-config-get.
        const payload = data && data.kiosk ? data.kiosk : data;
        msg.payload = payload;
        const label = (payload && (payload.name || payload.id)) || kioskId;
        node.status({ fill: "green", shape: "dot", text: String(label) });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }
  RED.nodes.registerType("bf-status", BfStatusNode);
};
