const { adminHeaders } = require("./_tenant.js");

module.exports = function (RED) {
  function parseJson(raw) {
    const text = (raw || "").toString().trim();
    if (!text) return {};
    return JSON.parse(text);
  }

  function maybeNumber(raw) {
    if (raw === undefined || raw === null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  function buildConfigParams(config) {
    const params = Object.assign({}, parseJson(config.params_json));
    const stringFields = [
      ["profileToken", config.profile_token],
      ["presetToken", config.preset_token],
      ["presetName", config.preset_name],
      ["auxiliaryData", config.auxiliary_data],
      ["relayToken", config.relay_token],
      ["logicalState", config.logical_state],
      ["videoSourceToken", config.video_source_token],
    ];
    for (const [key, value] of stringFields) {
      if (value !== undefined && value !== null && value !== "") params[key] = value;
    }
    const numberFields = [
      ["pan", config.pan],
      ["tilt", config.tilt],
      ["zoom", config.zoom],
      ["x", config.x],
      ["y", config.y],
      ["z", config.z],
      ["timeoutMs", config.timeout_ms],
    ];
    for (const [key, value] of numberFields) {
      const n = maybeNumber(value);
      if (n !== undefined) params[key] = n;
    }
    return params;
  }

  function BfOnvifNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);

    node.on("input", async (msg, send, done) => {
      if (!cfg || !cfg.server_url || !cfg.api_key) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return done(new Error("bf-server-config server_url + api_key required"));
      }
      const cameraId = msg.camera_id || config.camera_id;
      const action = (msg.action || config.action || "").toString().trim();
      if (!cameraId) {
        node.status({ fill: "red", shape: "ring", text: "missing camera_id" });
        return done(new Error("camera_id required"));
      }
      if (!action) {
        node.status({ fill: "red", shape: "ring", text: "missing action" });
        return done(new Error("action required"));
      }

      let params = {};
      try {
        params = Object.assign({}, buildConfigParams(config), msg.params || {});
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "bad params_json" });
        return done(err);
      }

      const url = cfg.server_url + "/api/admin/cameras/" + encodeURIComponent(String(cameraId)) + "/onvif";
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: adminHeaders(cfg, {
            "content-type": "application/json",
            accept: "application/json",
          }),
          body: JSON.stringify({ action, params }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false) {
          const code = data?.error?.code || ("HTTP " + r.status);
          const message = data?.error?.message || "ONVIF action failed";
          node.status({ fill: "red", shape: "ring", text: code });
          return done(new Error(message));
        }
        msg.payload = data.result;
        msg.bf_result = data;
        node.status({ fill: "green", shape: "dot", text: action });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }

  RED.nodes.registerType("bf-onvif", BfOnvifNode);
};
