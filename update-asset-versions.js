// update-asset-versions.js
//
// Zero-dependency Node script. Run this any time you change a file under
// public/assets/*.js or *.css, BEFORE committing/deploying.
//
// Why this exists: _headers now caches /assets/* for a full year
// (immutable). That's great for load speed, but it means a browser that
// already has app.js cached will keep using the OLD version forever,
// even after you deploy a change — UNLESS the URL itself changes. This
// project has no build step (no webpack/vite to auto-generate hashed
// filenames), so instead this script appends a content-hash query string
// (?v=xxxxxxxx) to every <script src="/assets/...">/<link href="/assets/...">
// reference in every HTML file. Changing the file's content changes its
// hash, which changes the URL, which busts the cache — without ever
// touching the actual filename on disk.
//
// Usage:  node update-asset-versions.js
//
// Idempotent: running it twice with no file changes makes zero edits
// (compares old content vs new content before writing).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
}

function collectAssetHashes() {
  const hashes = {};
  const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(js|css)$/i.test(entry.name)) continue;
    hashes[entry.name] = hashFile(path.join(ASSETS_DIR, entry.name));
  }
  return hashes;
}

function listHtmlFiles() {
  return fs
    .readdirSync(PUBLIC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => path.join(PUBLIC_DIR, e.name));
}

function updateHtmlFile(filePath, hashes) {
  const original = fs.readFileSync(filePath, 'utf8');
  let content = original;
  for (const [name, hash] of Object.entries(hashes)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Matches src="/assets/foo.js" or href="/assets/foo.css", with or
    // without an existing ?v=... suffix, and replaces/adds the current hash.
    const pattern = new RegExp(`((?:src|href)=["'])/assets/${escapedName}(?:\\?v=[a-f0-9]+)?(["'])`, 'g');
    content = content.replace(pattern, `$1/assets/${name}?v=${hash}$2`);
  }
  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

function main() {
  const hashes = collectAssetHashes();
  const htmlFiles = listHtmlFiles();
  let changedCount = 0;
  for (const file of htmlFiles) {
    const changed = updateHtmlFile(file, hashes);
    if (changed) {
      changedCount++;
      console.log(`updated: ${path.relative(__dirname, file)}`);
    }
  }
  console.log(`\n${Object.keys(hashes).length} asset(s) hashed, ${changedCount}/${htmlFiles.length} HTML file(s) updated.`);
}

main();
