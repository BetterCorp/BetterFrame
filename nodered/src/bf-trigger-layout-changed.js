/**
 * bf-trigger-layout-changed — fires when a display switches to a new layout.
 *
 * Topic filter: `layout.changed`. Server's nodered-bridge POSTs to
 * `${noderedUrl}/in/layout.changed` directly. This node self-registers its
 * own POST handler — no upstream `http in` node required.
 *
 * Optional config:
 *   - display_id: only fire for that display id
 *
 * Output msg.payload: { display_id, kiosk_id, layout_id, layout_name }
 */
const { readJsonBody } = require("./_http-body.js");

module.exports = function (RED) {
  const TOPIC = "layout.changed";
  const ROUTE = "/api/internal/" + TOPIC;

  function BfTriggerLayoutChangedNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const filterIdRaw = (config.display_id || "").toString().trim();
    const filterId = filterIdRaw && !isNaN(Number(filterIdRaw)) ? Number(filterIdRaw) : null;

    async function handler(req, res) {
      const body = await readJsonBody(req);
      const displayId = body.display_id !== undefined ? body.display_id : null;
      if (filterId !== null && Number(displayId) !== filterId) {
        return res.status(200).end();
      }
      const out = {
        topic: TOPIC,
        payload: {
          display_id: displayId,
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
  RED.nodes.registerType("bf-trigger-layout-changed", BfTriggerLayoutChangedNode);
};
