# Premium Laundry Management App

Mobile-first PWA for Premium Laundry & Garment Care (The Gambia).

- `docs/` – the web app served by GitHub Pages. Contains no secrets and no business data.
- `backend/` – Google Apps Script code (secure API, ledger migration, nightly backups). It runs inside the
  private Apps Script project bound to the ledger; this copy is for version control and review.

## Security model
Every API request carries a Google ID token. The backend verifies it with Google (signature via
`oauth2.googleapis.com/tokeninfo`, audience = this app's OAuth client ID, issuer, expiry, verified email)
and then checks the verified email against the private `Users` sheet (roles: Owner, Developer; Staff later).
The email sent by the browser is never trusted. Rejected requests are written to the private Audit Log.
No credentials, API keys or financial data are stored in this repository.
