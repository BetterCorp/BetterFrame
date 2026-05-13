module.exports = {
  uiHost: "0.0.0.0",
  uiPort: Number(process.env.PORT || 1880),
  httpAdminRoot: "/nrdp",
  httpNodeRoot: "/",
  functionGlobalContext: {},
  // Extra search paths for custom nodes. BF nodes baked into image at this path.
  nodesDir: ["/usr/src/betterframe-nodes"],
};
