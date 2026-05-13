/**
 * bf-trigger-camera-changed — fires when a camera entity is created, updated,
 * or deleted in admin.
 *
 * Topic filter: `camera.changed`. Server emits these from the admin camera
 * routes (manual create, ONVIF import, edit, delete, enable/disable).
 *
 * Output msg.payload: { camera_id, event: "created" | "updated" | "deleted" }
 */
module.exports = function (RED) {
  function BfTriggerCameraChangedNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on("input", function (msg, send, done) {
      const body = (msg && msg.payload && typeof msg.payload === "object") ? msg.payload : {};
      const topic = msg.topic || body.topic || "camera.changed";
      if (String(topic) !== "camera.changed") {
        return done && done();
      }
      const out = {
        topic: "camera.changed",
        payload: {
          camera_id: body.camera_id !== undefined ? body.camera_id : null,
          event: body.event || null,
        },
      };
      node.status({
        fill: "green",
        shape: "dot",
        text: String(out.payload.camera_id || "") + " " + (out.payload.event || ""),
      });
      send(out);
      done && done();
    });
  }
  RED.nodes.registerType("bf-trigger-camera-changed", BfTriggerCameraChangedNode);
};
