// Public configuration. Contains NO secrets: the OAuth client ID is public by design,
// and the API refuses every request without a Google-verified token for an authorised user.
// env must match the ledger's LEDGER_MODE on the server, otherwise the app refuses to work.
window.PL_CONFIG = {
  env: "LIVE",
  apiUrl: "https://script.google.com/macros/s/AKfycbxgAvWccascA_DKUhQ1Qf765MKPvnp4QXmgFAmnuTyANXgFA93C09l3ALaRu2KiJKpR/exec",
  googleClientId: "351882783399-76sd0am7fvp52guq2pqql27lcl1mg2pn.apps.googleusercontent.com",
  timeZone: "Africa/Banjul",
  appVersion: "0.5.1"
};
