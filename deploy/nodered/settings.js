const settings = {
  uiHost: "127.0.0.1",
  uiPort: Number(process.env.PORT || 1880),
  functionGlobalContext: {},
};

if (process.env.NODE_RED_CREDENTIAL_SECRET) {
  settings.credentialSecret = process.env.NODE_RED_CREDENTIAL_SECRET;
}

module.exports = settings;
