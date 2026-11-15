// Public configuration. Contains NO secrets: the OAuth client ID is public by design,
// and the API refuses every request without a Google-verified token for an authorised user.
// env must match the ledger's LEDGER_MODE on the server, otherwise the app refuses to work.
window.PL_CONFIG = {
  env: "TEST",
  apiUrl: "https://script.google.com/macros/s/AKfycbyx9Uc_pJWSBQZpUal4iKKjX56pQoi9D9ZaEraWjdAA4BR0AKlfzIlQk58osu-mey8XLg/exec",
  googleClientId: "351882783399-76sd0am7fvp52guq2pqql27lcl1mg2pn.apps.googleusercontent.com",
  timeZone: "Africa/Banjul",
  appVersion: "0.5.0"
};
