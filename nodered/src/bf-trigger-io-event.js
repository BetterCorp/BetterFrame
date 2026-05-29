/**
 * bf-trigger-io-event — fires on BetterFrame ioBOX events.
 *
 * Output: { topic, iobox_id, display_id, kind, action, code, payload }
 */
const { readJsonBody } = require("./_http-body.js");
const { tenantMatchesBody } = require("./_tenant.js");

module.exports = function (RED) {
  const ROUTE = "/api/internal/io.event";

  function BfTriggerIoEventNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);
    const filterIoBox = config.iobox_id ? String(config.iobox_id).trim() : null;
    const filterDisplay = config.display_id ? String(config.display_id).trim() : null;
    const filterKind = (config.kind || "").trim();
    const filterTopic = (config.topic_filter || "").trim();

    async function handler(req, res) {
      if (!cfg || !cfg.tenant_slug) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return res.status(200).end();
      }
      const body = await readJsonBody(req);
      if (!tenantMatchesBody(cfg, body, node)) {
        return res.status(200).end();
      }

      const topic = String(body.topic || "");
      const ioboxId = body.iobox_id ?? body.source_iobox_id ?? null;
      const displayId = body.display_id ?? body.payload?.display_id ?? null;
      const kind = String(body.kind ?? body.payload?.kind ?? "");

      if (filterTopic && !topic.includes(filterTopic)) return res.status(200).end();
      if (filterKind && kind !== filterKind) return res.status(200).end();
      if (filterIoBox !== null && String(ioboxId) !== filterIoBox) return res.status(200).end();
      if (filterDisplay !== null && String(displayId) !== filterDisplay) return res.status(200).end();

      const out = {
        event_id: body.event_id ?? null,
        topic,
        iobox_id: ioboxId,
        display_id: displayId,
        source_type: "io",
        kind,
        action: body.action ?? body.payload?.action ?? null,
        code: body.code ?? body.payload?.code ?? null,
        payload: body.payload ?? body,
        timestamp: body.timestamp ?? new Date().toISOString(),
      };

      node.status({ fill: "green", shape: "dot", text: kind || topic || "io event" });
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

  RED.nodes.registerType("bf-trigger-io-event", BfTriggerIoEventNode);
};
