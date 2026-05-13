/**
 * bf-snapshot — fetch a single JPEG frame for a camera entity.
 *
 * GETs /admin/entities/:id/snapshot, which pulls one frame from the entity's
 * main RTSP stream via ffmpeg/gst on the server. Returns image/jpeg or 502.
 *
 * On success: msg.payload = Buffer (binary JPEG), msg.contentType = "image/jpeg".
 * On 502 / network error: the node errors out with done(err) and shows red.
 *
 * config.entity_id: numeric (overridable by msg.entity_id)
 *
 * Typical use: motion event → bf-snapshot → email / telegram / save-to-disk.
 */
module.exports = function (RED) {
  function BfSnapshotNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);

    node.on("input", async (msg, send, done) => {
      if (!cfg || !cfg.server_url || !cfg.api_key) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return done(new Error("bf-server-config server_url + api_key required"));
      }
      const entityId = msg.entity_id || config.entity_id;
      if (!entityId) {
        node.status({ fill: "red", shape: "ring", text: "missing entity_id" });
        return done(new Error("entity_id required"));
      }
      const url = cfg.server_url + "/admin/entities/" + encodeURIComponent(String(entityId)) +
        "/snapshot";
      try {
        const r = await fetch(url, {
          method: "GET",
          headers: {
            authorization: "Bearer " + cfg.api_key,
            accept: "image/jpeg",
          },
        });
        if (r.status === 502) {
          node.status({ fill: "red", shape: "ring", text: "no snapshot" });
          return done(new Error("snapshot unavailable (HTTP 502)"));
        }
        if (!r.ok) throw new Error("HTTP " + r.status);
        const ab = await r.arrayBuffer();
        const buf = Buffer.from(ab);
        msg.payload = buf;
        msg.contentType = "image/jpeg";
        node.status({ fill: "green", shape: "dot", text: String(buf.length) + " B" });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }
  RED.nodes.registerType("bf-snapshot", BfSnapshotNode);
};
