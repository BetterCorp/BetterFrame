/**
 * bf-trigger-status — fires on kiosk heartbeat telemetry.
 *
 * Topic filter: `kiosk.status`. Server emits this from coordinator-ws each
 * time a kiosk pushes a status frame over the WS channel, separate from
 * the connect/disconnect/heartbeat envelope on `kiosk.changed`. Listening
 * here gives you a pure telemetry stream (no connect/disconnect noise).
 *
 * Optional config.kiosk_id filter — when set, only fires for that kiosk.
 *
 * Output msg.payload:
 *   { kiosk_id, kiosk_name, cpu_temp_c, fan_rpm, fan_pwm }
 */
module.exports = function (RED) {
  function BfTriggerStatusNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const filterIdRaw = (config.kiosk_id || "").toString().trim();
    const filterId = filterIdRaw ? Number(filterIdRaw) : null;

    node.on("input", function (msg, send, done) {
      const body = (msg && msg.payload && typeof msg.payload === "object") ? msg.payload : {};
      const topic = msg.topic || body.topic || "kiosk.status";
      if (String(topic) !== "kiosk.status") {
        return done && done();
      }
      const kioskId = body.kiosk_id !== undefined ? body.kiosk_id : null;
      if (filterId !== null && Number(kioskId) !== filterId) {
        return done && done();
      }
      const out = {
        topic: "kiosk.status",
        payload: {
          kiosk_id: kioskId,
          kiosk_name: body.kiosk_name || null,
          cpu_temp_c: body.cpu_temp_c !== undefined ? body.cpu_temp_c : null,
          fan_rpm: body.fan_rpm !== undefined ? body.fan_rpm : null,
          fan_pwm: body.fan_pwm !== undefined ? body.fan_pwm : null,
        },
      };
      const tempStr = out.payload.cpu_temp_c != null ? out.payload.cpu_temp_c + "C" : "";
      node.status({
        fill: "green",
        shape: "dot",
        text: (out.payload.kiosk_name || String(out.payload.kiosk_id || "")) + " " + tempStr,
      });
      send(out);
      done && done();
    });
  }
  RED.nodes.registerType("bf-trigger-status", BfTriggerStatusNode);
};
