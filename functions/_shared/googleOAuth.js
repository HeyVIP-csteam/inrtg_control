/**
 * googleOAuth.js
 * Exchanges the long-lived OAuth refresh token (a real user's Google
 * account, added as Editor on the other department's Sheet) for a
 * short-lived access token, on every request.
 *
 * This is SEPARATE from the existing service-account flow used by
 * submit.js / googleSheets.js (GOOGLE_SERVICE_ACCOUNT_*). Use THIS
 * helper only for Sheets you don't own — i.e. the ones a real person
 * had to grant access to via OAuth consent, because you can't ask that
 * department to share the Sheet with your service account.
 *
 * Required Cloudflare secrets (Production + Preview):
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REFRESH_TOKEN
 *
 * No caching here on purpose — Cloudflare Workers/Pages Functions are
 * short-lived per-request isolates, so an in-memory cache wouldn't
 * survive between requests anyway. Google's token endpoint is fast
 * (well under 200ms) so doing this once per request is fine.
 */
export async function getAccessToken(env) {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN env vars.");
  }

  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    // Most common cause if this ever fails: the refresh token was
    // revoked (account password changed, access manually revoked in
    // https://myaccount.google.com/permissions, or — if the OAuth app
    // ever gets flipped back to "Testing" in Google Cloud Console — a
    // 7-day-expiring token that lapsed). Re-run the OAuth Playground
    // flow to get a fresh one if that happens.
    throw new Error("Google OAuth token refresh failed: " + (data.error_description || data.error || res.status));
  }
  return data.access_token;
}
