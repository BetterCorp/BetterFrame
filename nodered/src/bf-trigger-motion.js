/**
 * bf-trigger-motion — fires on ONVIF motion detection events.
 *
 * Matches topics containing: MotionAlarm, CellMotionDetector, Motion,
 * VideoAnalytics/Motion. Camera ID filter optional.
 *
 * Output: { topic, kiosk_id, camera_id, active: boolean, payload }
 */
const { readJsonBody } = require("./_http-body.js");

const MOTION_PATTERNS = [
  "MotionAlarm",
  "CellMotionDetector",
  "VideoAnalytics",
  "Motion",
  "FieldDetector",
];

module.exports = function (RED) {
  const ROUTE = "/api/internal/onvif.motion";

  function BfTriggerMotionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const filterCam = config.camera_id ? String(config.camera_id).trim() : null;

    async function handler(req, res) {
      const body = await readJsonBody(req);
      const topic = String(body.topic || "");

      // Only fire for motion-related topics.
      if (!MOTION_PATTERNS.some((p) => topic.includes(p))) {
        return res.status(200).end();
      }

      const cameraId = body.camera_id ?? body.source_camera_id ?? null;
      if (filterCam !== null && String(cameraId) !== filterCam) {
        return res.status(200).end();
      }

      // Detect active/inactive from payload data.
      const data = body.payload?.data ?? body.payload ?? {};
      const active = data.IsMotion === "true" || data.State === "true"
        || data.Value === "true" || data.LogicalState === "true"
        || data.IsInside === "true";

      const out = {
        topic,
        kiosk_id: body.kiosk_id ?? body.source_kiosk_id ?? null,
        camera_id: cameraId,
        active,
        payload: body.payload ?? body,
      };
      node.status({
        fill: active ? "red" : "green",
        shape: "dot",
        text: active ? "Motion detected" : "Clear",
      });
      node.send(out);
      res.status(200).end();
    }

    RED.httpNode.post(ROUTE, handler);

    // Also listen on the generic onvif event route as fallback.
    const GENERIC_ROUTE = "/api/internal/onvif.event";
    RED.httpNode.post(GENERIC_ROUTE, handler);

    node.on("close", function (done) {
      const stack = RED.httpNode?._router?.stack;
      if (stack) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const layer = stack[i];
          if (!layer?.route) continue;
          if (layer.route.path !== ROUTE && layer.route.path !== GENERIC_ROUTE) continue;
          const inner = layer.route.stack;
          if (Array.isArray(inner)) {
            for (let j = inner.length - 1; j >= 0; j--) {
              if (inner[j]?.handle === handler) inner.splice(j, 1);
            }
            if (inner.length === 0) stack.splice(i, 1);
          }
        }
      }
      done();
    });
  }
  RED.nodes.registerType("bf-trigger-motion", BfTriggerMotionNode);
};
