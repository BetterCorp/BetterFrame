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
module.exports = function (RED) {
  const TOPIC = "display.power.changed";
  const ROUTE = "/api/internal/" + TOPIC;

  function BfTriggerDisplayPowerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const filterIdRaw = (config.display_id || "").toString().trim();
    const filterId = filterIdRaw && !isNaN(Number(filterIdRaw)) ? Number(filterIdRaw) : null;

    function handler(req, res) {
      const body = (req.body && typeof req.body === "object") ? req.body : {};
      const displayId = body.display_id !== undefined ? body.display_id : null;
      if (filterId !== null && Number(displayId) !== filterId) {
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
