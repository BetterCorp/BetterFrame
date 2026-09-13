const { timingSafeEqual } = require("node:crypto");
const { readJsonBody } = require("./_http-body.js");

const routers = new WeakMap();

function authenticated(req) {
  const expected = process.env.BF_NODERED_INTERNAL_TOKEN || "";
  const supplied = String(req.headers?.["x-betterframe-runtime-token"] || "");
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
}

// One HTTP route fans out to all interested nodes. A node's filter/response
// must not prevent other subscriptions from receiving the same event.
function subscribeEvent(RED, path, handler) {
  let routes = routers.get(RED.httpNode);
  if (!routes) { routes = new Map(); routers.set(RED.httpNode, routes); }
  let subscribers = routes.get(path);
  if (!subscribers) {
    subscribers = new Set();
    routes.set(path, subscribers);
    RED.httpNode.post(path, async (req, res) => {
      if (!authenticated(req)) return res.status(403).end();
      try {
        req.body = await readJsonBody(req);
        const sink = { status() { return this; }, end() { return this; }, json() { return this; } };
        await Promise.all([...subscribers].map(fn => Promise.resolve().then(() => fn(req, sink))));
        return res.status(200).end();
      } catch {
        return res.status(400).end();
      }
    });
  }
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

module.exports = { subscribeEvent };
