/**
 * Compresses a photo's raw bytes down under Telegram's real upload limit,
 * ONLY when it's actually over that limit — everything under the
 * threshold passes through untouched, at full original quality.
 *
 * Why this exists: sendPhoto / sendMediaGroup reject any single photo
 * over 10MB with a plain Telegram API error ("Bad Request: photo must be
 * smaller than 10MB" or similar), which otherwise surfaces to the agent
 * as a bare, non-actionable submission failure — see
 * telegram-photo-limit-fix.md for the original report. This never
 * touches videos or non-image documents; those don't go through here at
 * all (see the call sites in submit.js / forward.js / threads/[id].js,
 * which only route actual "photo"-kind attachments through this
 * function).
 *
 * Uses @cf-wasm/photon (a WASM build of the Rust `photon` image library)
 * because it runs directly in the Cloudflare Pages Functions runtime —
 * no native deps (Sharp, node-canvas, etc.) that Workers can't run.
 *
 * Threshold is 9.3MB, not 10MB — deliberate headroom, not the real
 * limit, since Telegram's own limit check happens on the exact
 * multipart-encoded bytes we send, and this project's own base64 ->
 * bytes round trip plus Telegram's own reported "must be smaller than"
 * wording has never been byte-for-byte pinned down. Cutting it close to
 * exactly 10MB risked the fix itself still failing right at the edge.
 */

const TELEGRAM_PHOTO_LIMIT_BYTES = 9.3 * 1024 * 1024;

// Each round tries a smaller JPEG quality first (cheap, no visible
// resizing) before also shrinking resolution — most oversized screenshots
// only need quality knocked down a little, so jumping straight to
// resizing would blur images that didn't need it. Resolution only comes
// into play once quality alone has stopped helping (rounds 4-6), each one
// shrinking by another ×0.75 on top of the last. Six rounds total is a
// hard ceiling — if a photo is still over the limit after all six, it's
// sent as-is rather than looping indefinitely (see the fallback below).
const COMPRESSION_STEPS = [
  { quality: 85, scale: 1 },
  { quality: 70, scale: 1 },
  { quality: 55, scale: 1 },
  { quality: 50, scale: 0.75 },
  { quality: 50, scale: 0.5625 }, // 0.75^2
  { quality: 50, scale: 0.421875 }, // 0.75^3
];

/**
 * @param {Uint8Array} bytes - raw image bytes (already decoded from the
 *   incoming base64 dataUrl — this function never touches the dataUrl
 *   string itself)
 * @param {string} mimeType - the attachment's declared type, e.g. "image/png"
 * @returns {Promise<{ bytes: Uint8Array, type: string, compressed: boolean }>}
 *   `compressed` is only true when this function actually re-encoded the
 *   image — callers that care (logging, etc.) can check it, but nothing
 *   downstream needs to branch on it: the returned bytes/type are always
 *   safe to send to Telegram either way.
 */
export async function compressImageForTelegram(bytes, mimeType) {
  if (!bytes || bytes.byteLength <= TELEGRAM_PHOTO_LIMIT_BYTES) {
    return { bytes, type: mimeType, compressed: false };
  }

  let inputImage = null;
  try {
    // Imported lazily (not at module top level) so that any environment
    // where this module gets loaded but photo compression never actually
    // runs (i.e. every attachment stays under the threshold) never pays
    // for initializing the WASM module at all.
    const { PhotonImage, resize, SamplingFilter } = await import("@cf-wasm/photon/workerd");

    inputImage = PhotonImage.new_from_byteslice(bytes);
    const width = inputImage.get_width();
    const height = inputImage.get_height();

    let outputBytes = null;
    for (const step of COMPRESSION_STEPS) {
      let working = inputImage;
      let isResized = false;
      if (step.scale < 1) {
        const w = Math.max(1, Math.round(width * step.scale));
        const h = Math.max(1, Math.round(height * step.scale));
        // Always resizes from the original full-resolution image, not
        // from the previous round's already-shrunk output — resizing
        // down from a smaller image each round would compound blur for
        // no size benefit over resizing from the original at the same
        // target dimensions.
        working = resize(inputImage, w, h, SamplingFilter.Lanczos3);
        isResized = true;
      }
      outputBytes = working.get_bytes_jpeg(step.quality);
      if (isResized) working.free();
      if (outputBytes.byteLength <= TELEGRAM_PHOTO_LIMIT_BYTES) break;
    }

    // Still over the limit after all six rounds (an extreme source
    // image) — send the smallest version this got to rather than the
    // untouched original, since it's strictly closer to fitting even if
    // it doesn't quite make it. Telegram's own error, if it still
    // rejects it, is at least now the true failure mode rather than one
    // this function silently pretended not to have a fix for.
    return { bytes: outputBytes, type: "image/jpeg", compressed: true };
  } catch (e) {
    // Compression itself is a nice-to-have, not something that should
    // ever block a send — if @cf-wasm/photon throws (corrupt image,
    // format it can't decode, unexpected WASM error), fall straight back
    // to the original bytes. Telegram will either accept them anyway
    // (this function's own threshold has headroom) or return its usual
    // "too large" error, same as before this fix existed — never worse.
    console.error("telegramImageCompress: compression failed, sending original bytes instead:", e && e.message || e);
    return { bytes, type: mimeType, compressed: false };
  } finally {
    if (inputImage) inputImage.free();
  }
}
