/**
 * bf-trigger-web-change - fires when a kiosk WebView loads or navigates.
 *
 * Output msg.payload: { url, entity_id, view_id, display_id, kiosk_id }
 */
const { readJsonBody } = require("./_http-body.js");
const { tenantMatchesBody } = require("./_tenant.js");

module.exports = function (RED) {
  const TOPIC = "web-change";
  const ROUTE = "/api/internal/" + TOPIC;

  function BfTriggerWebChangeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);
    const filterKiosk = String(config.kiosk_id || "").trim() || null;
    const filterDisplay = String(config.display_id || "").trim() || null;
    const filterView = String(config.view_id || "").trim() || null;
    const filterEntity = String(config.entity_id || "").trim() || null;
    const filterUrl = String(config.url_contains || "").trim();

    async function handler(req, res) {
      if (!cfg || !cfg.tenant_slug) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return res.status(200).end();
      }
      const body = await readJsonBody(req);
      if (!tenantMatchesBody(cfg, body, node)) {
        return res.status(200).end();
      }

      const url = body.url !== undefined ? String(body.url) : "";
      const kioskId = body.kiosk_id !== undefined ? String(body.kiosk_id) : null;
      const displayId = body.display_id !== undefined ? String(body.display_id) : null;
      const viewId = body.view_id !== undefined && body.view_id !== null ? String(body.view_id) : null;
      const entityId = body.entity_id !== undefined && body.entity_id !== null ? String(body.entity_id) : null;

      if (filterKiosk !== null && kioskId !== filterKiosk) return res.status(200).end();
      if (filterDisplay !== null && displayId !== filterDisplay) return res.status(200).end();
      if (filterView !== null && viewId !== filterView) return res.status(200).end();
      if (filterEntity !== null && entityId !== filterEntity) return res.status(200).end();
      if (filterUrl && !url.includes(filterUrl)) return res.status(200).end();

      const out = {
        topic: TOPIC,
        payload: {
          url,
          entity_id: entityId,
          view_id: viewId,
          display_id: displayId,
          kiosk_id: kioskId,
          tenant_slug: body.tenant_slug || null,
          tenant_key: body.tenant_key || body.tenant_slug || null,
          source: body.source || "kiosk",
        },
      };
      node.status({ fill: "green", shape: "dot", text: url || "web change" });
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

  RED.nodes.registerType("bf-trigger-web-change", BfTriggerWebChangeNode);
};
