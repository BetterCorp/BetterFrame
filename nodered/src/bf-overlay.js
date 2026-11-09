const { adminHeaders } = require("./_tenant.js");
module.exports = function (RED) {
  function BfOverlayNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);
    node.on("input", async (msg, send, done) => {
      try {
        if (!cfg || !cfg.server_url || !cfg.api_key) throw new Error("bf-server-config required");
        const id = msg.block_id || config.block_id;
        if (!id) throw new Error("block_id required");
        if (!msg.payload || typeof msg.payload !== "object" || Array.isArray(msg.payload)) throw new Error("msg.payload must be a JSON object");
        const response = await fetch(cfg.server_url.replace(/\/+$/, "") + "/api/admin/blocks/" + encodeURIComponent(id) + "/overlay", {
          method: "POST", headers: adminHeaders(cfg, { "content-type": "application/json" }),
          body: JSON.stringify({ data: msg.payload }), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          const detail = body && typeof body.error === "string" ? body.error : "";
          throw new Error("HTTP " + response.status + (detail ? ": " + detail : ""));
        }
        msg.payload = (await response.json()).overlay;
        node.status({ fill: "green", shape: "dot", text: "updated" });
        send(msg); done();
      } catch (error) {
        node.status({ fill: "red", shape: "ring", text: error.message });
        done(error);
      }
    });
  }
  RED.nodes.registerType("bf-overlay", BfOverlayNode);
};
