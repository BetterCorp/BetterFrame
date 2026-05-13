/**
 * Tiny JSON body reader for trigger nodes.
 *
 * RED.httpNode.post(path, handler) registers a raw Express route with no
 * body parser, so req.body is undefined. Trigger nodes call readJsonBody(req)
 * to get a parsed object (or {} on error / non-JSON).
 *
 * Zero dependencies — avoids relying on Node-RED's bundled body-parser being
 * resolvable from our nodesDir.
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

module.exports = { readJsonBody };
