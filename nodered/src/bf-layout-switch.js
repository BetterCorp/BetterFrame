/**
 * bf-layout-switch — call BF admin `POST /admin/displays/:displayId/layout/:layoutId`
 * to switch a display to a specific layout. The coordinator-ws plugin then
 * delivers a `layout-switch` message to the owning kiosk over WebSocket.
 *
 * Inputs:
 *   - config.display_id, config.layout_id  (statically configured)
 *   - msg.display_id, msg.layout_id        (per-message overrides)
 */
module.exports = function (RED) {
  function BfLayoutSwitchNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);

    node.on("input", async (msg, send, done) => {
      if (!cfg || !cfg.server_url || !cfg.api_key) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return done(new Error("bf-server-config server_url + api_key required"));
      }
      const displayId = msg.display_id || config.display_id;
      const layoutId = msg.layout_id || config.layout_id;
      if (!displayId || !layoutId) {
        node.status({ fill: "red", shape: "ring", text: "missing ids" });
        return done(new Error("display_id and layout_id required"));
      }
      const url = cfg.server_url + "/admin/displays/" + encodeURIComponent(String(displayId)) +
        "/layout/" + encodeURIComponent(String(layoutId));
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { authorization: "Bearer " + cfg.api_key },
          redirect: "manual",
        });
        // 200/302 both indicate success in BF; 302 is the post-redirect-to-admin response.
        if (!r.ok && r.status !== 302) {
          throw new Error("HTTP " + r.status);
        }
        node.status({ fill: "green", shape: "dot", text: "switched " + displayId + "→" + layoutId });
        msg.bf_result = { display_id: Number(displayId), layout_id: Number(layoutId), status: r.status };
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }
  RED.nodes.registerType("bf-layout-switch", BfLayoutSwitchNode);
};
