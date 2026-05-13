/**
 * bf-trigger-kiosk-changed — fires on kiosk state changes (connect, disconnect,
 * heartbeat with hardware telemetry).
 *
 * Topic filter: `kiosk.changed`. Server emits these from the coordinator-ws
 * plugin on WS connect/disconnect and from heartbeat status messages.
 *
 * Output msg.payload:
 *   { kiosk_id, kiosk_name,
 *     event: "connected" | "disconnected" | "heartbeat",
 *     cpu_temp_c?: number, fan_rpm?: number, fan_pwm?: number }
 */
module.exports = function (RED) {
  function BfTriggerKioskChangedNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on("input", function (msg, send, done) {
      const body = (msg && msg.payload && typeof msg.payload === "object") ? msg.payload : {};
      const topic = msg.topic || body.topic || "kiosk.changed";
      if (String(topic) !== "kiosk.changed") {
        return done && done();
      }
      const out = {
        topic: "kiosk.changed",
        payload: {
          kiosk_id: body.kiosk_id !== undefined ? body.kiosk_id : null,
          kiosk_name: body.kiosk_name || null,
          event: body.event || null,
          cpu_temp_c: body.cpu_temp_c !== undefined ? body.cpu_temp_c : null,
          fan_rpm: body.fan_rpm !== undefined ? body.fan_rpm : null,
          fan_pwm: body.fan_pwm !== undefined ? body.fan_pwm : null,
        },
      };
      node.status({
        fill: "green",
        shape: "dot",
        text: (out.payload.kiosk_name || String(out.payload.kiosk_id || "")) + " " + (out.payload.event || ""),
      });
      send(out);
      done && done();
    });
  }
  RED.nodes.registerType("bf-trigger-kiosk-changed", BfTriggerKioskChangedNode);
};
