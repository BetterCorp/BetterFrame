function trimTenantValue(value) {
  return (value || "").toString().trim();
}

function adminHeaders(cfg, extra) {
  const headers = Object.assign({
    authorization: "Bearer " + trimTenantValue(cfg.api_key),
    "x-betterframe-tenant": trimTenantValue(cfg.tenant_slug) || "default",
  }, extra || {});
  return headers;
}

function tenantMatchesBody(cfg, body, node) {
  const expected = trimTenantValue(cfg && cfg.tenant_slug) || "default";
  const actual = trimTenantValue(body && body.tenant_slug);
  if (!actual) {
    if (node && typeof node.warn === "function") {
      node.warn("BetterFrame trigger payload missing tenant_slug");
    }
    return false;
  }
  return actual === expected;
}

module.exports = {
  adminHeaders,
  tenantMatchesBody,
  trimTenantValue,
};
