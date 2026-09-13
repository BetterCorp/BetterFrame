const { subscribeEvent } = require("./_event-dispatch.js");
/**
 * bf-trigger-display-power — fires when a display's power state changes.
 *
 * Topic filter: `display.power.changed`. Server's `nodered-bridge.forward`
 * POSTs to `${noderedUrl}/api/internal/display.power.changed` directly. This node
 * registers its own POST handler on Node-RED's user-facing HTTP server —
 * no upstream `http in` node required.
 *
 * Optional config:
 *   - display_id: only fire for that display id
 *
 * Output msg.payload: { display_id, kiosk_id, state: "on" | "standby" }
 */
const { readJsonBody } = require("./_http-body.js");
const { tenantMatchesBody } = require("./_tenant.js");
const { withIdentity } = require("./_identity.js");

module.exports = function (RED) {
  const TOPIC = "display.power.changed";
  const ROUTE = "/api/internal/" + TOPIC;

  function BfTriggerDisplayPowerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);
    const filterId = String(config.display_id || "").trim() || null;

    async function handler(req, res) {
      if (!cfg || !cfg.tenant_slug) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return res.status(200).end();
      }
      const body = await readJsonBody(req);
      if (!tenantMatchesBody(cfg, body, node)) {
        return res.status(200).end();
      }
      const displayId = body.display_id !== undefined ? String(body.display_id) : null;
      if (filterId !== null && displayId !== filterId) {
        return res.status(200).end();
      }
      const out = {
        topic: TOPIC,
        payload: withIdentity(body, {
          display_id: displayId,
          kiosk_id: body.kiosk_id !== undefined ? body.kiosk_id : null,
          state: body.state || null,
        }),
      };
      node.status({ fill: "green", shape: "dot", text: out.payload.state || "changed" });
      node.send(out);
      res.status(200).end();
    }

    const unsubscribe = [subscribeEvent(RED, ROUTE, handler)];

    node.on("close", function (done) {
      for (const off of unsubscribe) off();
      done();
    });
  }
  RED.nodes.registerType("bf-trigger-display-power", BfTriggerDisplayPowerNode);
};
