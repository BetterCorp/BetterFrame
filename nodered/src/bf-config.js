/**
 * bf-config — shared config node holding BetterFrame server URL + admin API key.
 *
 * Other bf-* action/query nodes reference this via `config.config` in their
 * editor UI. The API key is treated as `credentials` so Node-RED encrypts it
 * at rest.
 */
module.exports = function (RED) {
  function BfConfigNode(n) {
    RED.nodes.createNode(this, n);
    this.name = n.name;
    this.server_url = (n.server_url || "").replace(/\/+$/, "");
    // credentials.api_key is auto-merged onto `this` by Node-RED.
    this.api_key = (this.credentials && this.credentials.api_key) || "";
  }
  RED.nodes.registerType("bf-config", BfConfigNode, {
    credentials: {
      api_key: { type: "password" },
    },
  });
};
