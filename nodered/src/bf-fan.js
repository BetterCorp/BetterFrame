/**
 * bf-fan — POST /admin/kiosks/:id/fan {mode, pwm}.
 *
 * mode=auto: BF kiosk-side hwmon thermostat controls the fan.
 * mode=pwm: pwm (0..255) is sent directly. Use msg.pwm or msg.mode to
 * override the configured values.
 */
module.exports = function (RED) {
  function BfFanNode(config) {
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
      const mode = (msg.mode || config.mode || "auto").toLowerCase();
      let formBody;
      let label;
      if (mode === "pwm") {
        const pwm = Number(msg.pwm !== undefined ? msg.pwm : config.pwm) || 0;
        const clamped = Math.max(0, Math.min(255, Math.round(pwm)));
        formBody = "mode=pwm&pwm=" + String(clamped);
        label = "pwm=" + clamped;
      } else {
        formBody = "mode=auto";
        label = "auto";
      }
      const url = cfg.server_url + "/admin/kiosks/" + encodeURIComponent(String(kioskId)) + "/fan";
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            authorization: "Bearer " + cfg.api_key,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: formBody,
          redirect: "manual",
        });
        if (!r.ok && r.status !== 302) throw new Error("HTTP " + r.status);
        node.status({ fill: "green", shape: "dot", text: "fan " + label });
        msg.bf_result = { kiosk_id: Number(kioskId), mode, status: r.status };
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }
  RED.nodes.registerType("bf-fan", BfFanNode);
};
