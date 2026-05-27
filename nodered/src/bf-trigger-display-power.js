/**
 * bf-trigger-display-power — fires when a display's power state changes.
 *
 * Topic filter: `display.power.changed`. Server's `nodered-bridge.forward`
 * POSTs to `${noderedUrl}/in/display.power.changed` directly. This node
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
        payload: {
          display_id: displayId,
          kiosk_id: body.kiosk_id !== undefined ? body.kiosk_id : null,
          state: body.state || null,
        },
      };
      node.status({ fill: "green", shape: "dot", text: out.payload.state || "changed" });
      node.send(out);
      res.status(200).end();
    }

    RED.httpNode.post(ROUTE, handler);

    node.on("close", function (done) {
      // Remove this node's specific route layer from the Express router.
      // `app.post(path, handler)` creates a route layer whose inner stack
      // holds the actual handler. Match by handler ref so other instances
      // of the same node type aren't disturbed.
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
  RED.nodes.registerType("bf-trigger-display-power", BfTriggerDisplayPowerNode);
};
