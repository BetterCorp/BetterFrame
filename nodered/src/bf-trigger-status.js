/**
 * bf-trigger-status — fires on kiosk heartbeat telemetry.
 *
 * Topic filter: `kiosk.status`. Server's nodered-bridge POSTs to
 * `${noderedUrl}/in/kiosk.status` directly. This node self-registers its
 * own POST handler — no upstream `http in` node required.
 *
 * Optional config:
 *   - kiosk_id: only fire for that kiosk id
 *
 * Output msg.payload:
 *   { kiosk_id, kiosk_name, cpu_temp_c, fan_rpm, fan_pwm }
 */
const { readJsonBody } = require("./_http-body.js");
const { tenantMatchesBody } = require("./_tenant.js");

module.exports = function (RED) {
  const TOPIC = "kiosk.status";
  const ROUTE = "/api/internal/" + TOPIC;

  function BfTriggerStatusNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);
    const filterIdRaw = (config.kiosk_id || "").toString().trim();
    const filterId = filterIdRaw && !isNaN(Number(filterIdRaw)) ? Number(filterIdRaw) : null;

    async function handler(req, res) {
      if (!cfg || !cfg.tenant_slug) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return res.status(200).end();
      }
      const body = await readJsonBody(req);
      if (!tenantMatchesBody(cfg, body, node)) {
        return res.status(200).end();
      }
      const kioskId = body.kiosk_id !== undefined ? body.kiosk_id : null;
      if (filterId !== null && Number(kioskId) !== filterId) {
        return res.status(200).end();
      }
      const out = {
        topic: TOPIC,
        payload: {
          kiosk_id: kioskId,
          kiosk_name: body.kiosk_name || null,
          cpu_temp_c: body.cpu_temp_c !== undefined ? body.cpu_temp_c : null,
          fan_rpm: body.fan_rpm !== undefined ? body.fan_rpm : null,
          fan_pwm: body.fan_pwm !== undefined ? body.fan_pwm : null,
        },
      };
      const tempStr = out.payload.cpu_temp_c != null ? out.payload.cpu_temp_c + "C" : "";
      node.status({
        fill: "green",
        shape: "dot",
        text: (out.payload.kiosk_name || String(out.payload.kiosk_id || "")) + " " + tempStr,
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
  RED.nodes.registerType("bf-trigger-status", BfTriggerStatusNode);
};
