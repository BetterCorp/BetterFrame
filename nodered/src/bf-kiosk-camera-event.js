/**
 * bf-kiosk-camera-event — fires on kiosk-originated camera events forwarded
 * from the BetterFrame server (ONVIF motion, object detection, line crossing,
 * GPIO pulse tagged to a camera, etc.).
 *
 * The server's api-http `/api/kiosk/events` endpoint persists each kiosk
 * event then calls `nodered.forward(topic, payload)` which POSTs to
 * `${noderedUrl}/in/<topic>`. This node self-registers a POST handler at a
 * fixed route — no upstream `http in` node required.
 *
 * Optional config:
 *   - camera_id: only fire for that camera id
 *
 * Output msg shape (kept compatible with the previous filter version):
 *   { topic, kiosk_id, camera_id, source_type, payload }
 */
const { readJsonBody } = require("./_http-body.js");
const { tenantMatchesBody } = require("./_tenant.js");

module.exports = function (RED) {
  // Fixed ingest route. Server-side forwarders that want this node to receive
  // their event should POST to /in/camera.event. (Previous releases used a
  // glob-pattern filter over upstream http-in messages; that path is gone.)
  const TOPIC = "camera.event";
  const ROUTE = "/api/internal/" + TOPIC;

  function BfKioskCameraEventNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);
    const filterId = (config.camera_id || "").toString().trim() || null;

    async function handler(req, res) {
      if (!cfg || !cfg.tenant_slug) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return res.status(200).end();
      }
      const body = await readJsonBody(req);
      if (!tenantMatchesBody(cfg, body, node)) {
        return res.status(200).end();
      }
      const kioskId = body.kiosk_id !== undefined ? body.kiosk_id
        : body.source_kiosk_id !== undefined ? body.source_kiosk_id
        : null;
      const cameraId = body.camera_id !== undefined ? body.camera_id
        : body.source_camera_id !== undefined ? body.source_camera_id
        : null;
      if (filterId !== null && String(cameraId) !== filterId) {
        return res.status(200).end();
      }
      const out = {
        topic: body.topic ? String(body.topic) : TOPIC,
        kiosk_id: kioskId,
        camera_id: cameraId,
        source_type: body.source_type || null,
        payload: body.payload !== undefined ? body.payload : body,
      };
      node.status({ fill: "green", shape: "dot", text: out.topic });
      node.send(out);
      res.status(200).end();
    }

    RED.httpNode.post(ROUTE, handler);

    node.on("close", function (done) {
      const stack = RED.httpNode && RED.httpNode._router && RED.httpNode._router.stack;
      if (stack) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const layer = stack[i];
          if (!layer || !layer.route || layer.route.path !== ROUTE) continue;
          const inner = layer.route.stack;
          if (Array.isArray(inner)) {
            for (let j = inner.length - 1; j >= 0; j--) {
              if (inner[j] && inner[j].handle === handler) inner.splice(j, 1);
            }
            if (inner.length === 0) stack.splice(i, 1);
          }
        }
      }
      done();
    });
  }
  RED.nodes.registerType("bf-kiosk-camera-event", BfKioskCameraEventNode);
};
