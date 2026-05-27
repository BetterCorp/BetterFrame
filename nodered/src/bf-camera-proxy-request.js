/**
 * bf-camera-proxy-request - fetch a camera-local HTTP path via the kiosk.
 *
 * Uses /api/admin/cameras/:id/proxy so the server asks a connected kiosk that
 * has the camera in its bundle to fetch the path from the camera/NVR LAN.
 */
const { adminHeaders } = require("./_tenant.js");

function normalizePath(raw) {
  const value = (raw || "").toString().trim();
  if (!value) return "";
  try {
    const u = new URL(value);
    return (u.pathname || "/") + (u.search || "");
  } catch {
    return value.startsWith("/") ? value : "/" + value;
  }
}

module.exports = function (RED) {
  function BfCameraProxyRequestNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);

    node.on("input", async (msg, send, done) => {
      if (!cfg || !cfg.server_url || !cfg.api_key) {
        node.status({ fill: "red", shape: "ring", text: "missing bf-server-config" });
        return done(new Error("bf-server-config server_url + api_key required"));
      }
      const cameraId = msg.camera_id || config.camera_id;
      if (!cameraId) {
        node.status({ fill: "red", shape: "ring", text: "missing camera_id" });
        return done(new Error("camera_id required"));
      }
      const path = normalizePath(msg.path || msg.pictureUri || config.path);
      if (!path) {
        node.status({ fill: "red", shape: "ring", text: "missing path" });
        return done(new Error("path or pictureUri required"));
      }

      const url = cfg.server_url + "/api/admin/cameras/" + encodeURIComponent(String(cameraId)) +
        "/proxy?path=" + encodeURIComponent(path);
      try {
        const r = await fetch(url, {
          method: "GET",
          headers: adminHeaders(cfg, { accept: "*/*" }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const ab = await r.arrayBuffer();
        const buf = Buffer.from(ab);
        msg.payload = buf;
        msg.contentType = r.headers.get("content-type") || "application/octet-stream";
        msg.camera_proxy_path = path;
        node.status({ fill: "green", shape: "dot", text: String(buf.length) + " B" });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }
  RED.nodes.registerType("bf-camera-proxy-request", BfCameraProxyRequestNode);
};
