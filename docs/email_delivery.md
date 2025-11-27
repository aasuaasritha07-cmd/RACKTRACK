# Email Delivery Guide

This document explains how the server handles contact email delivery and admin operations.

## How email delivery works
- The server persists contact-form messages but does not perform email delivery.
- Email delivery is handled on the client using EmailJS (recommended), which allows immediate sends from the browser using public keys.
- The server records email metadata in the contacts store (emailSent, attempts, lastAttemptAt, lastError) so admins can monitor and manage deliveries.

## Email delivery (EmailJS client-side)
This project uses EmailJS on the client to deliver contact emails from the browser. The server only persists contacts and records metadata for monitoring and admin actions; it does not perform email delivery.

To configure EmailJS client-side, set these Vite environment variables in `client/.env` or an appropriate `.env.*` file:
```
VITE_EMAILJS_SERVICE_ID=service_1ibdm2n
VITE_EMAILJS_TEMPLATE_ID=template_xxxxx
VITE_EMAILJS_PUBLIC_KEY=public_xxxxx
```
Restart your client dev server after setting the variables.

## Configure EmailJS (client-side)
- If you'd like to use EmailJS from the browser (no server-side Resend required), add the following env vars to your client environment (.env or Vite env files). These should be prefixed with VITE_ so Vite exposes them to the client build:
```
VITE_EMAILJS_SERVICE_ID=service_1ibdm2n
VITE_EMAILJS_TEMPLATE_ID=template_xxxxx
VITE_EMAILJS_PUBLIC_KEY=public_xxxxx
```
Add these to a client-specific `.env.development` or `.env` file inside the `client/` folder if you run a separate client process. These variables are safe for frontend use (EmailJS uses public keys), but you should still be careful about how you share them publicly.

In the browser, the app will automatically attempt to send via EmailJS first (if configured) and persist the message to the server for storage. If the EmailJS send fails, the server will still keep the message for later resend via admin endpoints.

## Test send (safe)
- The server-side test send endpoint is disabled because email delivery is handled by EmailJS on the client.
- To test, use your client (the Contact form) to send a message and check EmailJS logs and your configured recipient inbox.

### Sandbox / local testing
Use EmailJS test templates or your own Mailbox to verify email delivery. The server does not perform sends; the admin endpoints only show persisted contacts.

## Admin endpoints (protected)
These endpoints are protected using `x-test-key: <CONTACT_TEST_KEY>` header.

- GET /api/admin/contacts/unsent
  - Lists contacts that have not been successfully emailed yet.
  - Usage:
  ```bash
  curl -H "x-test-key: your-test-key" http://localhost:3000/api/admin/contacts/unsent
  ```

- POST /api/admin/contacts/:id/resend
  - Server-side resend operations are disabled. This endpoint returns HTTP 501 (Not Implemented).
  - Usage:
  ```bash
  curl -X POST -H "x-test-key: your-test-key" http://localhost:3000/api/admin/contacts/3c9b...-id-/resend
  ```

- POST /api/admin/contacts/resend-unsent
  - Server-side bulk resend operations are disabled. This endpoint returns HTTP 501 (Not Implemented).
  - Usage:
  ```bash
  curl -X POST -H "x-test-key: your-test-key" http://localhost:3000/api/admin/contacts/resend-unsent
  ```

## Notes & Security
- Do not share your `CONTACT_TEST_KEY` or any server-side secret publicly.
- Use the hosting platform's secure environment/secret management to store keys.
- If the `RESEND_API_KEY` was leaked, revoke it in the Resend dashboard and create a new key.
- The admin endpoints use a shared test key for simplicity; consider adding real authentication before enabling on a public deployment.

## Removing secrets from repo & rotating keys
- If you ever committed `.env` (or any file containing a secret) to git, you must remove it from the index and rotate the key.
  1. Remove the sensitive files from git index (untrack them):
    ```powershell
    git rm --cached .env
    git rm --cached client/.env.production
    git commit -m "Remove sensitive env files from repo"
    git push
    ```
  2. Optionally, rewrite history to purge the secret, if it's been pushed publicly (this rewrites history and requires force pushing — make sure all contributors are aware):
    ```powershell
    # Use with caution: this rewrites history for the default branch
    git filter-branch --force --index-filter "git rm --cached --ignore-unmatch .env" --prune-empty --tag-name-filter cat -- --all
    git push origin --force --all
    git push origin --force --tags
    ```
  3. Immediately rotate the leaked key in Resend dashboard: revoke old key and create new key.
  4. Set the new key only in your production environment variables (e.g., Render dashboard) and your local `.env` (never commit `.env`).

## Build-time safety
The repo contains a small `scripts/check-secrets.js` script which fails `npm run build` if it detects server-side secrets such as `GMAIL_APP_PASSWORD` or `RESEND_API_KEY` in `client/.env.production`. This prevents accidental inclusion of the secret in the frontend bundle.


## Next steps
- Add a small admin UI to show unsent messages and allow resending.
- Add a background worker to automatically retry unsent messages with backoff.
- Add logging and dashboard integration for monitoring delivery success.
