/**
 * googleOAuth.js  (SERVER-ONLY)
 *
 * Real user-delegated Google OAuth 2.0 access — used ONLY by the Deposit
 * Issue / Deposit Backup modules. Every other module in this hub
 * (submit.js, promo-search.js, etc.) uses the service account in
 * googleSheets.js instead — don't switch those over to this file.
 *
 * WHY THIS EXISTS (don't "simplify" this back to a service account):
 * The rest of the hub writes to Sheets via a Google Cloud service
 * account, which requires the Sheet's owner to add that service
 * account's email as a collaborator. The Deposit Issue / Deposit Backup
 * sheets belong to a different department that will not do that. So
 * instead, this module "impersonates" a real Google account that the
 * OTHER department has already added as an Editor on those sheets —
 * Google issues an access token for that real person, and every
 * read/write goes through as if that person did it themselves.
 *
 * HOW THIS WAS SET UP (already done — nothing to redo unless the
 * refresh token gets revoked or expires):
 *   1. A real Google account already granted Editor access on the
 *      Deposit Support sheet(s) completed the OAuth consent flow once
 *      (Google OAuth Playground, or a one-off authorize/callback
 *      script), granting the https://www.googleapis.com/auth/spreadsheets
 *      scope.
 *   2. The resulting refresh_token was saved as a Cloudflare secret,
 *      alongside the OAuth Client's id/secret — three secrets total,
 *      set for BOTH Production and Preview:
 *        GOOGLE_OAUTH_CLIENT_ID
 *        GOOGLE_OAUTH_CLIENT_SECRET
 *        GOOGLE_OAUTH_REFRESH_TOKEN
 *   3. The OAuth consent screen in Google Cloud Console MUST be in
 *      "In production" publishing status, NOT "Testing" — Testing-mode
 *      refresh tokens silently expire after 7 days. If Deposit Issue/
 *      Backup suddenly start failing with an invalid_grant error, check
 *      this publishing status (or whether the refresh token was
 *      revoked) FIRST before assuming the code is broken.
 *
 * This file only ever exchanges the existing refresh_token for a fresh
 * access_token (cached per Worker isolate, same pattern as
 * googleSheets.js's service-account token cache) — it does not
 * implement the authorize/callback flow itself. That was a one-time
 * setup step already completed, not something this app repeats in
 * normal operation.
 */

let cachedToken = null; // { token, expiresAt }

export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 30) {
    return cachedToken.token;
  }

  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    // invalid_grant here almost always means: consent screen reverted to
    // Testing mode (7-day expiry) or the refresh token was revoked —
    // see the comment above before debugging the code itself.
    throw new Error(`Google OAuth refresh failed: ${JSON.stringify(data)}`);
  }

  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return data.access_token;
}
