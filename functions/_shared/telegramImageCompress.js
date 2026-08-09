/**
 * telegramImageCompress.js  (SERVER-ONLY)
 *
 * Fixes the "整组消失" (whole album silently disappears) bug: Telegram's
 * sendPhoto/sendMediaGroup reject ANY photo over 10MB, and a rejected
 * sendMediaGroup fails ALL-OR-NOTHING (one oversized photo in a 3-photo
 * album kills the other two as well, not just the big one). The old
 * behavior let that rejection happen and then silently degraded the
 * whole ticket to a bare text message — see telegram-photo-limit-fix.md
 * for the full incident writeup this module resolves.
 *
 * Strategy: compress BEFORE handing bytes to Telegram, not after Telegram
 * already said no. Only the copy sent to Telegram is touched — the
 * original bytes uploaded to R2 (see _shared/r2.js) are never passed
 * through this function, so the archived screenshot keeps full quality.
 *
 * Uses @cf-wasm/photon — a Rust (photon-rs) image library compiled to
 * WASM, chosen specifically because it runs in the Cloudflare
 * Workers/Pages runtime without any Node APIs (Sharp/Canvas need Node
 * and don't work here). Must be declared in package.json so Cloudflare
 * Pages' build step runs `npm install` and bundles it.
 */
import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon/workerd";

// Telegram's real limit is 10MB for sendPhoto / each item in
// sendMediaGroup. Target a bit under that so re-encoding overhead,
// EXIF, etc. can't push a "just barely under" result back over on
// Telegram's side.
const TELEGRAM_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const TARGET_BYTES = 9.3 * 1024 * 1024;

// Each round (after the first) shrinks resolution by this factor and
// drops to the next quality step below. Six rounds takes even a huge
// original (e.g. a 4000px-wide 20MB+ screenshot) down to a fraction of
// its starting linear size, which is always enough in practice — if it
// somehow still isn't, the caller gets back the smallest bytes this
// managed to produce rather than nothing at all.
const MAX_ROUNDS = 6;
const RESIZE_FACTOR = 0.75;
const QUALITY_STEPS = [85, 75, 65, 55, 45, 40];

/**
 * Compresses one image's bytes down under Telegram's photo size limit,
 * if (and only if) it's currently over the target. Never throws — on
 * any WASM/decoding failure this logs and returns the ORIGINAL bytes
 * unchanged, so a compression bug degrades back to the old "Telegram
 * might reject this" behavior instead of blocking the send entirely.
 *
 * @param {Uint8Array} bytes
 * @param {{ type?: string, name?: string }} meta
 * @returns {Promise<{ bytes: Uint8Array, type: string, name: string, wasCompressed: boolean }>}
 */
export async function compressImageForTelegram(bytes, { type, name } = {}) {
  const originalType = type || "application/octet-stream";
  const originalName = name || "photo.jpg";

  if (!bytes || !bytes.byteLength || bytes.byteLength <= TARGET_BYTES) {
    return { bytes, type: originalType, name: originalName, wasCompressed: false };
  }

  let inputImage = null;
  let workingImage = null;
  try {
    inputImage = PhotonImage.new_from_byteslice(bytes);
    let width = inputImage.get_width();
    let height = inputImage.get_height();
    let best = bytes;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const quality = QUALITY_STEPS[Math.min(round, QUALITY_STEPS.length - 1)];

      if (round === 0) {
        // First pass: just re-encode at the original resolution with a
        // lower JPEG quality — for a lot of oversized PNG/HEIC-derived
        // screenshots this alone is enough, and it keeps the image
        // looking identical if it is.
        best = inputImage.get_bytes_jpeg(quality);
      } else {
        width = Math.max(1, Math.round(width * RESIZE_FACTOR));
        height = Math.max(1, Math.round(height * RESIZE_FACTOR));
        const resized = resize(inputImage, width, height, SamplingFilter.Lanczos3);
        if (workingImage) workingImage.free();
        workingImage = resized;
        best = workingImage.get_bytes_jpeg(quality);
      }

      if (best.byteLength <= TARGET_BYTES) break;
    }

    return {
      bytes: best,
      // Always re-encoded as JPEG (get_bytes_jpeg), so the extension/MIME
      // type sent to Telegram has to match what the bytes actually are.
      type: "image/jpeg",
      name: renameToJpeg(originalName),
      wasCompressed: true,
    };
  } catch (e) {
    console.error(`[telegramImageCompress] compression failed for "${originalName}" (${bytes.byteLength} bytes) — sending original bytes as-is: ${(e && e.message) || e}`);
    return { bytes, type: originalType, name: originalName, wasCompressed: false };
  } finally {
    // WASM-backed objects — must be freed explicitly, GC won't do it.
    if (workingImage) { try { workingImage.free(); } catch { /* already freed */ } }
    if (inputImage) { try { inputImage.free(); } catch { /* already freed */ } }
  }
}

function renameToJpeg(name) {
  const base = (name || "photo").replace(/\.[^./\\]+$/, "");
  return `${base}.jpg`;
}

export { TELEGRAM_PHOTO_LIMIT_BYTES, TARGET_BYTES };
