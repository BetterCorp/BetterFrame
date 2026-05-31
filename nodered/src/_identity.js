function asId(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function firstId(body, keys) {
  for (const key of keys) {
    const top = asId(body && body[key]);
    if (top !== null) return top;
    const nested = asId(body && body.payload && body.payload[key]);
    if (nested !== null) return nested;
  }
  return null;
}

function eventIdentity(body, overrides) {
  const o = overrides || {};
  const tenantKey = asId(o.tenant_key)
    ?? firstId(body, ["tenant_key", "tenant_slug"]);
  return {
    entity_id: asId(o.entity_id) ?? firstId(body, ["entity_id"]),
    camera_id: asId(o.camera_id) ?? firstId(body, ["camera_id", "source_camera_id"]),
    layout_id: asId(o.layout_id) ?? firstId(body, ["layout_id"]),
    display_id: asId(o.display_id) ?? firstId(body, ["display_id"]),
    kiosk_id: asId(o.kiosk_id) ?? firstId(body, ["kiosk_id", "source_kiosk_id"]),
    tenant_key: tenantKey,
    tenant_id: asId(o.tenant_id) ?? firstId(body, ["tenant_id"]) ?? tenantKey,
  };
}

function withIdentity(body, fields) {
  return Object.assign(eventIdentity(body), fields || {});
}

module.exports = {
  eventIdentity,
  withIdentity,
};
