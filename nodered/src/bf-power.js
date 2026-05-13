/**
 * bf-power — POST /admin/kiosks/:id/power/(wake|standby) to wake or sleep
 * the display attached to a kiosk. Server fans out to the kiosk over WS,
 * the kiosk then runs CEC + DPMS sequentially.
 *
 * config.mode: "wake" | "standby" (can also be set via msg.mode)
 * config.kiosk_id: numeric (can be overridden by msg.kiosk_id)
 */
module.exports = function (RED) {
  function BfPowerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);

    node.on("input", async (msg, send, done) => {
      if (!cfg || !cfg.server_url || !cfg.api_key) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return done(new Error("bf-server-config server_url + api_key required"));
      }
      const kioskId = msg.kiosk_id || config.kiosk_id;
      const mode = (msg.mode || config.mode || "wake").toLowerCase();
      if (!kioskId) {
        node.status({ fill: "red", shape: "ring", text: "missing kiosk_id" });
        return done(new Error("kiosk_id required"));
      }
      if (mode !== "wake" && mode !== "standby") {
        node.status({ fill: "red", shape: "ring", text: "bad mode" });
        return done(new Error("mode must be wake or standby"));
      }
      const url = cfg.server_url + "/admin/kiosks/" + encodeURIComponent(String(kioskId)) +
        "/power/" + mode;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { authorization: "Bearer " + cfg.api_key },
          redirect: "manual",
        });
        if (!r.ok && r.status !== 302) throw new Error("HTTP " + r.status);
        node.status({ fill: "green", shape: "dot", text: mode + " " + kioskId });
        msg.bf_result = { kiosk_id: Number(kioskId), mode, status: r.status };
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }
  RED.nodes.registerType("bf-power", BfPowerNode);
};
