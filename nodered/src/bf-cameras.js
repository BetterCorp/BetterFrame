/**
 * bf-cameras — query the BF admin for the camera list. Emits a message
 * whose `msg.payload` is an array of cameras:
 *   [{id, name, type, enabled, labels: [...]}, ...]
 *
 * Optional filter: `config.label` — if set, only include cameras carrying
 * that label name (or msg.label override).
 *
 * Use this for populating UI dropdowns or driving "all cameras" loops.
 */
module.exports = function (RED) {
  function BfCamerasNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);

    node.on("input", async (msg, send, done) => {
      if (!cfg || !cfg.server_url || !cfg.api_key) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-config" });
        return done(new Error("bf-config server_url + api_key required"));
      }
      const filterLabel = (msg.label || config.label || "").trim().toLowerCase();
      const url = cfg.server_url + "/api/admin/cameras";
      try {
        const r = await fetch(url, {
          method: "GET",
          headers: {
            authorization: "Bearer " + cfg.api_key,
            accept: "application/json",
          },
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        let cameras = Array.isArray(data) ? data : (data.cameras || []);
        if (filterLabel) {
          cameras = cameras.filter((c) => Array.isArray(c.labels) && c.labels.indexOf(filterLabel) >= 0);
        }
        node.status({ fill: "green", shape: "dot", text: String(cameras.length) + " cameras" });
        msg.payload = cameras;
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }
  RED.nodes.registerType("bf-cameras", BfCamerasNode);
};
