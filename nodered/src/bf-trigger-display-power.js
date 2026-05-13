/**
 * bf-trigger-display-power — fires when a display's power state changes.
 *
 * Topic filter: `display.power.changed`. Server emits these from the admin
 * power routes (wake/standby) and the kiosk power-state-check probe (future).
 *
 * Wire an upstream `http in POST /in/kiosk/display.power.changed` (or any
 * source landing the event body in msg.payload) into this node.
 *
 * Output msg.payload: { display_id, kiosk_id, state: "on" | "standby" }
 */
module.exports = function (RED) {
  function BfTriggerDisplayPowerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on("input", function (msg, send, done) {
      const body = (msg && msg.payload && typeof msg.payload === "object") ? msg.payload : {};
      const topic = msg.topic || body.topic || "display.power.changed";
      if (String(topic) !== "display.power.changed") {
        return done && done();
      }
      const out = {
        topic: "display.power.changed",
        payload: {
          display_id: body.display_id !== undefined ? body.display_id : null,
          kiosk_id: body.kiosk_id !== undefined ? body.kiosk_id : null,
          state: body.state || null,
        },
      };
      node.status({ fill: "green", shape: "dot", text: out.payload.state || "changed" });
      send(out);
      done && done();
    });
  }
  RED.nodes.registerType("bf-trigger-display-power", BfTriggerDisplayPowerNode);
};
