/**
 * bf-server-config — shared config node holding BetterFrame server URL + admin
 * API key. Every other bf-* node references one of these in its editor UI via
 * the `config` field. The API key is stored as credentials so Node-RED encrypts
 * it at rest.
 *
 * Previously named `bf-config`; renamed to disambiguate from the new
 * `bf-config-get` / `bf-config-set` flow nodes.
 */
module.exports = function (RED) {
  function BfServerConfigNode(n) {
    RED.nodes.createNode(this, n);
    this.name = n.name;
    this.server_url = (n.server_url || "").replace(/\/+$/, "");
    // credentials.api_key is auto-merged onto `this` by Node-RED.
    this.api_key = (this.credentials && this.credentials.api_key) || "";
  }
  RED.nodes.registerType("bf-server-config", BfServerConfigNode, {
    credentials: {
      api_key: { type: "password" },
    },
  });
};
