/**
 * bf-trigger-event — fires on ANY ONVIF event from any camera.
 *
 * Generic catch-all for event topics not handled by the specialized
 * motion/ANPR nodes. Configurable topic filter (substring match) and
 * camera ID filter.
 *
 * Output: { topic, kiosk_id, camera_id, source, data, payload }
 */
const { readJsonBody } = require("./_http-body.js");

module.exports = function (RED) {
  const ROUTE = "/api/internal/onvif.event";

  function BfTriggerEventNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const filterCam = config.camera_id ? Number(config.camera_id) : null;
    const filterTopic = (config.topic_filter || "").trim();

    async function handler(req, res) {
      const body = await readJsonBody(req);
      const topic = String(body.topic || "");

      if (filterTopic && !topic.includes(filterTopic)) {
        return res.status(200).end();
      }

      const cameraId = body.camera_id ?? body.source_camera_id ?? null;
      if (filterCam !== null && Number(cameraId) !== filterCam) {
        return res.status(200).end();
      }

      const source = body.payload?.source ?? {};
      const data = body.payload?.data ?? {};

      const out = {
        topic,
        kiosk_id: body.kiosk_id ?? body.source_kiosk_id ?? null,
        camera_id: cameraId,
        source,
        data,
        payload: body.payload ?? body,
      };

      // Show the topic in the node status badge.
      const shortTopic = topic.length > 40
        ? "..." + topic.slice(topic.length - 37)
        : topic;
      node.status({ fill: "green", shape: "dot", text: shortTopic });
      node.send(out);
      res.status(200).end();
    }

    RED.httpNode.post(ROUTE, handler);

    node.on("close", function (done) {
      const stack = RED.httpNode?._router?.stack;
      if (stack) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const layer = stack[i];
          if (!layer?.route || layer.route.path !== ROUTE) continue;
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
  RED.nodes.registerType("bf-trigger-event", BfTriggerEventNode);
};
