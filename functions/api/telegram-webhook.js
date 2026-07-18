/**
 * telegram-webhook.js
 *
 * Register this URL with Telegram once (from your own machine, not this
 * app — Telegram calls it, we don't call ourselves):
 *
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *     -d "url=https://inrtg-control.pages.dev/api/telegram-webhook" \
 *     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
 *     -d "allowed_updates=[\"message\"]"
 *
 * `TELEGRAM_WEBHOOK_SECRET` is a string you make up yourself (any random
 * value works) and set as a Cloudflare secret with that same name — it's
 * how we verify a request genuinely came from Telegram and not some rando
 * hitting this URL directly.
 *
 * Every message posted in the bot's groups (agent replies included) is
 * delivered here. We only care about ones that are a reply (Telegram's
 * native "reply to message" feature) to a message we originally sent for
 * a submission — everything else is ignored.
 */
import { findThreadIdByMessage, appendMessage } from "../_shared/threads.js";

export async function onRequestPost({ request, env }) {
  // Verify the request really came from Telegram.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok"); // Always 200 quickly — Telegram retries on non-2xx.
  }

  try {
    await handleUpdate(env, update);
  } catch {
    // Swallow errors — a broken reply-sync should never make Telegram think
    // the webhook is unhealthy and start retrying/backing off.
  }
  return new Response("ok");
}

async function handleUpdate(env, update) {
  if (!env.THREADS_KV) return;
  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  if (!msg.reply_to_message) return; // Only tracking direct replies to our tickets.

  const threadId = await findThreadIdByMessage(env, msg.chat.id, msg.reply_to_message.message_id);
  if (!threadId) return;

  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Unknown";
  await appendMessage(env, threadId, {
    from: name,
    handle: msg.from?.username ? `@${msg.from.username}` : null,
    text: msg.text || msg.caption || "(attachment)",
    ts: new Date((msg.date || Date.now() / 1000) * 1000).toISOString(),
    self: false,
  });
}
