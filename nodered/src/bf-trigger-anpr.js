const { subscribeEvent } = require("./_event-dispatch.js");
/**
 * bf-trigger-anpr — fires on ONVIF license plate recognition events.
 *
 * Matches topics containing: LicensePlateRecognition, Plate, ANPR, LPR.
 * Extracts plate number + confidence from payload data.
 *
 * Output: { topic, kiosk_id, camera_id, plate, confidence, payload }
 */
const { readJsonBody } = require("./_http-body.js");
const { tenantMatchesBody } = require("./_tenant.js");
const { eventIdentity } = require("./_identity.js");

const ANPR_PATTERNS = [
  "LicensePlateRecognition",
  "Plate",
  "ANPR",
  "LPR",
  "NumberPlate",
];

module.exports = function (RED) {
  const ROUTE = "/api/internal/onvif.anpr";

  function BfTriggerAnprNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const cfg = RED.nodes.getNode(config.config);
    const filterCam = config.camera_id ? String(config.camera_id).trim() : null;

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

      if (!ANPR_PATTERNS.some((p) => topic.includes(p))) {
        return res.status(200).end();
      }

      const cameraId = body.camera_id ?? body.source_camera_id ?? null;
      if (filterCam !== null && String(cameraId) !== filterCam) {
        return res.status(200).end();
      }

      const data = body.payload?.data ?? body.payload ?? {};
      // Hikvision uses PlateNumber, other vendors may vary.
      const plate = data.PlateNumber ?? data.plateNumber ?? data.Plate
        ?? data.plate ?? data.Value ?? null;
      const confidence = data.Confidence ?? data.confidence
        ?? data.Score ?? data.score ?? null;

      const out = {
        ...eventIdentity(body, { camera_id: cameraId }),
        topic,
        kiosk_id: body.kiosk_id ?? body.source_kiosk_id ?? null,
        camera_id: cameraId,
        plate: plate ? String(plate) : null,
        confidence: confidence != null ? Number(confidence) : null,
        payload: body.payload ?? body,
      };
      node.status({
        fill: plate ? "blue" : "yellow",
        shape: "dot",
        text: plate || "plate detected",
      });
      node.send(out);
      res.status(200).end();
    }

    const unsubscribe = [subscribeEvent(RED, ROUTE, handler)];

    const GENERIC_ROUTE = "/api/internal/onvif.event";
    unsubscribe.push(subscribeEvent(RED, GENERIC_ROUTE, handler));

    node.on("close", function (done) {
      for (const off of unsubscribe) off();
      done();
    });
  }
  RED.nodes.registerType("bf-trigger-anpr", BfTriggerAnprNode);
};
