/**
 * bf-kiosk-camera-event — fire a flow whenever a BetterFrame kiosk camera
 * event matching a topic pattern arrives. Defaults to `camera.*` (ONVIF
 * motion, object detection, line crossing, etc.).
 *
 * Two delivery paths can land here:
 *   1. The BF server has forwarded an authenticated kiosk event via the
 *      `/in/kiosk/<topic>` ingest endpoint. The flow operator wires an
 *      `http in` node on that path and connects it to this node — we just
 *      filter by topic.
 *   2. A separate flow injects msg.topic + msg.payload directly.
 *
 * This is a pure filter/router. It does NOT itself subscribe to the BF
 * server; that wiring is done with stock Node-RED http-in or websocket
 * nodes upstream.
 *
 * Renamed from `bf-event-in` — kept the same envelope shape for backward
 * compatibility with flows that consume the output message.
 */
module.exports = function (RED) {
  function BfKioskCameraEventNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const pattern = (config.topic_pattern || "camera.*").trim();

    // Convert glob-ish pattern to RegExp: `camera.*` → /^camera\..*$/
    function toRegex(p) {
      if (!p) return null;
      const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp("^" + escaped + "$");
    }
    const re = toRegex(pattern);

    node.on("input", function (msg, send, done) {
      // Common BF envelope shape:
      //   { topic, kiosk_id, camera_id, source_type, payload }
      // We accept either a fully-formed msg or one where the body lives in
      // msg.payload (typical for Node-RED http-in).
      const body = (msg && msg.payload && typeof msg.payload === "object") ? msg.payload : {};
      const topic = msg.topic || body.topic || "";
      if (!topic) {
        node.status({ fill: "yellow", shape: "ring", text: "no topic" });
        return done && done();
      }
      if (re && !re.test(String(topic))) {
        // Filter miss — drop silently.
        return done && done();
      }
      const out = {
        topic: String(topic),
        kiosk_id: msg.kiosk_id || body.kiosk_id || body.source_kiosk_id || null,
        camera_id: msg.camera_id || body.camera_id || body.source_camera_id || null,
        source_type: body.source_type || null,
        payload: body.payload !== undefined ? body.payload : body,
      };
      node.status({ fill: "green", shape: "dot", text: out.topic });
      send(out);
      done && done();
    });
  }
  RED.nodes.registerType("bf-kiosk-camera-event", BfKioskCameraEventNode);
};
