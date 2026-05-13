/**
 * bf-trigger-layout-changed — fires when a display switches to a new layout.
 *
 * Topic filter: `layout.changed`. Server emits these from the admin layout-
 * switch routes after delivering the WS command to the kiosk.
 *
 * Output msg.payload: { display_id, kiosk_id, layout_id, layout_name }
 */
module.exports = function (RED) {
  function BfTriggerLayoutChangedNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on("input", function (msg, send, done) {
      const body = (msg && msg.payload && typeof msg.payload === "object") ? msg.payload : {};
      const topic = msg.topic || body.topic || "layout.changed";
      if (String(topic) !== "layout.changed") {
        return done && done();
      }
      const out = {
        topic: "layout.changed",
        payload: {
          display_id: body.display_id !== undefined ? body.display_id : null,
          kiosk_id: body.kiosk_id !== undefined ? body.kiosk_id : null,
          layout_id: body.layout_id !== undefined ? body.layout_id : null,
          layout_name: body.layout_name || null,
        },
      };
      node.status({
        fill: "green",
        shape: "dot",
        text: out.payload.layout_name || String(out.payload.layout_id || ""),
      });
      send(out);
      done && done();
    });
  }
  RED.nodes.registerType("bf-trigger-layout-changed", BfTriggerLayoutChangedNode);
};
