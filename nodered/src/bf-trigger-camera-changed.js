const { subscribeEvent } = require("./_event-dispatch.js");
/**
 * bf-trigger-camera-changed — fires when a camera entity is created, updated,
 * or deleted in admin.
 *
 * Topic filter: `camera.changed`. Server's nodered-bridge POSTs to
 * `${noderedUrl}/api/internal/camera.changed` directly. This node self-registers its
 * own POST handler — no upstream `http in` node required.
 *
 * Optional config:
 *   - camera_id: only fire for that camera id
 *
 * Output msg.payload: { camera_id, event: "created" | "updated" | "deleted" }
 */
const { readJsonBody } = require("./_http-body.js");
const { tenantMatchesBody } = require("./_tenant.js");
const { withIdentity } = require("./_identity.js");

module.exports = function (RED) {
  const TOPIC = "camera.changed";
  const ROUTE = "/api/internal/" + TOPIC;

  function BfTriggerCameraChangedNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);
    const filterId = String(config.camera_id || "").trim() || null;

    async function handler(req, res) {
      if (!cfg || !cfg.tenant_slug) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return res.status(200).end();
      }
      const body = await readJsonBody(req);
      if (!tenantMatchesBody(cfg, body, node)) {
        return res.status(200).end();
      }
      const camId = body.camera_id !== undefined ? String(body.camera_id) : null;
      if (filterId !== null && camId !== filterId) {
        return res.status(200).end();
      }
      const out = {
        topic: TOPIC,
        payload: withIdentity(body, {
          camera_id: camId,
          event: body.event || null,
        }),
      };
      node.status({
        fill: "green",
        shape: "dot",
        text: String(out.payload.camera_id || "") + " " + (out.payload.event || ""),
      });
      node.send(out);
      res.status(200).end();
    }

    const unsubscribe = [subscribeEvent(RED, ROUTE, handler)];

    node.on("close", function (done) {
      for (const off of unsubscribe) off();
      done();
    });
  }
  RED.nodes.registerType("bf-trigger-camera-changed", BfTriggerCameraChangedNode);
};
